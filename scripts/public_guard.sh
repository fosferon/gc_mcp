#!/usr/bin/env bash
# public_guard.sh: refuse to publish internal material from this public repo.
#
# Scans every tracked file for personal paths, private addresses, internal issue
# references and AI-tool/working-paper artefacts. Extra patterns that must not
# themselves be published (client names) are read from PUBLIC_GUARD_EXTRA
# (one ERE per line) or from $PUBLIC_GUARD_EXTRA_FILE. Exit 1 on any finding.
#
# PUBLIC_GUARD_REQUIRE_EXTRA=1 makes a missing or empty extra-pattern list an error
# instead of a silent skip; CI and the pre-push hook set it.
set -euo pipefail

top=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "public_guard: not inside a git work tree (git rev-parse --show-toplevel failed)" >&2
  exit 1
}
cd "$top" || {
  echo "public_guard: cannot enter git work tree: $top" >&2
  exit 1
}

self='^scripts/public_guard(_test)?\.sh$'
patterns=(
  '/Us'"ers/[A-Za-z]"
  '/ho'"me/[a-z]+/"
  '[A-Za-z0-9._%+-]+@gmail\.com'
  '\b192\.168\.[0-9]+\.[0-9]+'
  '\b10\.[0-9]+\.[0-9]+\.[0-9]+'
  '\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+'
  '\bGC-[0-9]+'
  '\bgc[-_/]?[0-9]{3,}'
)
builtin=${#patterns[@]}

fail=0
extra="${PUBLIC_GUARD_EXTRA:-}"
if [[ -z "$extra" && -n "${PUBLIC_GUARD_EXTRA_FILE:-}" ]]; then
  if [[ -r "$PUBLIC_GUARD_EXTRA_FILE" ]]; then
    extra="$(cat "$PUBLIC_GUARD_EXTRA_FILE")"
  else
    echo "public_guard: PUBLIC_GUARD_EXTRA_FILE is set but not readable"; fail=1
  fi
fi
while IFS= read -r p; do
  p=${p%$'\r'}; p="${p#"${p%%[![:space:]]*}"}"; p="${p%"${p##*[![:space:]]}"}"
  [[ -n "$p" && "$p" != \#* ]] && patterns+=("$p")
done <<< "$extra"
if [[ "${PUBLIC_GUARD_REQUIRE_EXTRA:-}" == 1 && ${#patterns[@]} -eq $builtin ]]; then
  echo "public_guard: extra patterns are required but none were loaded"; fail=1
fi

# Repo-local allowance for identifiers that the public API contract deliberately
# exposes (e.g. a daemon URL variable). A tracked .public-guard-allow lists exact
# literal tokens, one per line. A token is removed from a line only when the whole
# token matches (surrounded by non-identifier characters) before extra patterns are
# matched; a token that merely contains one as a substring is not exempt. A missing
# or empty allow file means no allowance. The allow file itself is not excluded
# from scanning, so built-in patterns inside it still fail.
allow=()
allow_file="$top/.public-guard-allow"
if [[ -r "$allow_file" ]]; then
  while IFS= read -r a; do
    a=${a%$'\r'}; a="${a#"${a%%[![:space:]]*}"}"; a="${a%"${a##*[![:space:]]}"}"
    [[ -n "$a" && "$a" != \#* ]] && allow+=("$a")
  done < "$allow_file"
fi
allow_re=""
if ((${#allow[@]})); then
  for a in "${allow[@]}"; do
    esc=$(printf '%s' "$a" | sed 's/[][\\.^$*+?(){}|]/\\&/g')
    allow_re+="${allow_re:+|}${esc}"
  done
fi
allow_sed=""
if [[ -n "$allow_re" ]]; then
  # Consume one delimiter on each side; repeat until stable so adjacent tokens
  # ("TOKEN TOKEN") are removed too, not only the first of a run.
  allow_sed="s/(^|[^A-Za-z0-9_])($allow_re)([^A-Za-z0-9_]|$)/\1\3/g"
fi
strip_allow() {
  local cur nxt
  cur=$(mktemp) || return 1
  nxt=$(mktemp) || { rm -f "$cur"; return 1; }
  cat > "$cur" || { rm -f "$cur" "$nxt"; return 1; }
  while :; do
    sed -E "$allow_sed" "$cur" > "$nxt" || { rm -f "$cur" "$nxt"; return 1; }
    if cmp -s "$cur" "$nxt"; then break; fi
    mv "$nxt" "$cur" || { rm -f "$cur" "$nxt"; return 1; }
    nxt=$(mktemp) || { rm -f "$cur"; return 1; }
  done
  cat "$cur"
  rm -f "$cur" "$nxt"
}

# NUL-delimited end to end: unusual file names are scanned, never skipped.
list_files() { git ls-files -z | grep -zEv "$self" || true; }
names=$(git -c core.quotePath=false ls-files)
names=$(printf '%s\n' "$names" | grep -Ev "$self" || true)
if [[ -z "$names" ]]; then
  echo "public_guard: no scannable tracked files after excluding the guard; refusing to report clean" >&2
  exit 1
fi

artefacts=$(echo "$names" | grep -E '(^|/)(CLAUDE\.md|AGENTS\.md|\.claude/|\.serena/|\.dev'"man/"'|_bmad[^/]*/|\.planning/|\.cursor/|\.swarm/|node_modules/|\.npmrc|\.env($|\.))' || true)
papers=$(echo "$names" | grep -E '^[A-Z0-9_]+\.md$' | grep -Ev '^(README|CHANGELOG|LICENSE|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|READINESS|DEVELOPMENT)\.md$' || true)
if [[ -n "$artefacts$papers" ]]; then
  echo "public_guard: internal artefacts or working papers are tracked:"; printf "%s\n%s\n" "$artefacts" "$papers" | sed '/^$/d; s/^/  /'
  fail=1
fi

# A built-in hit is exempt only when it carries a visible "public-guard: allow
# (<reason>)" marker, either on its own line or as a comment-only line directly above
# it (where formatters put it). A marker trailing a code line exempts that line
# alone. For fixtures that must contain the pattern (private-range SSRF tests, stamps
# in already-applied migrations). Extra (client-name) patterns are never exempt.
marker='public-guard: allow \([^)]+\)'
for i in "${!patterns[@]}"; do
  p=${patterns[$i]}
  errf=$(mktemp); listf=$(mktemp)
  list_files | xargs -0 -r grep -I -l --null -i -E -- "$p" >"$listf" 2>"$errf" || true
  # Exit codes differ between GNU and BSD xargs; any grep diagnostic is a scan error.
  if [[ -s "$errf" ]]; then
    echo "public_guard: scan error for pattern #$((i + 1))"; sed 's/^/  /' "$errf"; rm -f "$errf" "$listf"; fail=1; continue
  fi
  hits=""
  while IFS= read -r -d '' f; do
    filtered=""
    if (( i >= builtin )) && [[ -n "$allow_sed" ]]; then
      filtered=$(mktemp) || { echo "public_guard: cannot create temp file"; rm -f "$errf" "$listf"; exit 1; }
      if ! strip_allow < "$f" > "$filtered"; then
        echo "public_guard: scan error applying allowlist to $f"
        rm -f "$errf" "$listf" "$filtered"; fail=1; continue
      fi
    fi
    while IFS= read -r m; do
      n=${m%%:*}
      if (( i < builtin )); then
        if sed -n "${n}p" < "$f" | grep -qE "$marker"; then continue; fi
        if (( n > 1 )) && sed -n "$((n - 1))p" < "$f" | grep -qE "^[[:space:]]*(#|//|--|;|%|\*|/\*|<!--)[[:space:]]*${marker}"; then continue; fi
        hits+="$f:$m"$'\n'
      else
        hits+="$f:$n: (extra pattern #$((i - builtin + 1)))"$'\n'
      fi
    done < <(grep -I -n -i -E -- "$p" "${filtered:-$f}")
    if [[ -n "$filtered" ]]; then rm -f "$filtered"; fi
  done < "$listf"
  rm -f "$errf" "$listf"
  if [[ -n "$hits" ]]; then
    echo "public_guard: forbidden pattern found:"; printf '%s' "$hits" | head -20 | sed 's/^/  /'
    fail=1
  fi
done

[[ $fail -eq 0 ]] && echo "public_guard: clean"
exit $fail
