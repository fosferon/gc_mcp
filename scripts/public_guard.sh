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
  '~
  '~/'
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

# NUL-delimited end to end: unusual file names are scanned, never skipped.
list_files() { git ls-files -z | grep -zEv "$self" || true; }
names=$(git -c core.quotePath=false ls-files)
names=$(printf '%s\n' "$names" | grep -Ev "$self" || true)
if [[ -z "$names" ]]; then
  echo "public_guard: no scannable tracked files after excluding the guard; refusing to report clean" >&2
  exit 1
fi

artefacts=$(echo "$names" | grep -E '(^|/)(CLAUDE\.md|AGENTS\.md|\.claude/|\.serena/|\.REDACTED/|_bmad[^/]*/|\.planning/|\.cursor/|\.swarm/|node_modules/|\.npmrc|\.env($|\.))' || true)
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
    while IFS= read -r m; do
      n=${m%%:*}
      if (( i < builtin )); then
        if sed -n "${n}p" < "$f" | grep -qE "$marker"; then continue; fi
        if (( n > 1 )) && sed -n "$((n - 1))p" < "$f" | grep -qE "^[[:space:]]*(#|//|--|;|%|\*|/\*|<!--)[[:space:]]*${marker}"; then continue; fi
        hits+="$f:$m"$'\n'
      else
        hits+="$f:$n: (extra pattern #$((i - builtin + 1)))"$'\n'
      fi
    done < <(grep -I -n -i -E -- "$p" "$f")
  done < "$listf"
  rm -f "$errf" "$listf"
  if [[ -n "$hits" ]]; then
    echo "public_guard: forbidden pattern found:"; printf '%s' "$hits" | head -20 | sed 's/^/  /'
    fail=1
  fi
done

[[ $fail -eq 0 ]] && echo "public_guard: clean"
exit $fail
