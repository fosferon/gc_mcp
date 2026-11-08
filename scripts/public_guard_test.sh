#!/usr/bin/env bash
# Fixture test for public_guard.sh: every pattern class must still trip, and a
# clean tree must pass, so that editing a pattern cannot silently disable it.
set -uo pipefail
guard="$(cd "$(dirname "$0")" && pwd)/public_guard.sh"
hook="$(cd "$(dirname "$0")/.." && pwd)/.githooks/pre-push"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cd "$work" && git init -q . && git config user.email t@t && git config user.name t
mkdir scripts && cp "$guard" scripts/public_guard.sh

expect() { # expect <0|1> <description>
  PUBLIC_GUARD_EXTRA="${EXTRA:-}" PUBLIC_GUARD_REQUIRE_EXTRA="${REQUIRE:-}" PUBLIC_GUARD_EXTRA_FILE="${XFILE:-}" \
    bash scripts/public_guard.sh >/dev/null 2>&1; got=$?
  if [[ $got -ne $1 ]]; then echo "FAIL: $2 (exit $got, expected $1)"; exit 1; fi
  echo "ok: $2"
}
reset() { git rm -rq --cached . >/dev/null 2>&1; find . -mindepth 1 -maxdepth 1 ! -name .git ! -name scripts -exec rm -rf {} +; git add scripts; }
add() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; git add "$1"; }

reset; add lib/a.ex 'defmodule A, do: nil';                         expect 0 "clean tree passes"
reset; add lib/a.ex "path = \"/Us""ers/someone/x\"";                  expect 1 "personal macOS path"
reset; add lib/a.ex "mail = \"x@gm""ail.com\"";                       expect 1 "personal email"
reset; add lib/a.ex "url = \"http://192.""168.1.5:80\"";               expect 1 "LAN address"
reset; add lib/a.ex "path = \"/ho""me/someone/x\"";                 expect 1 "personal Linux path"
reset; add lib/a.ex "host = \"10.""0.0.7\"";                          expect 1 "private 10.x address"
reset; add lib/a.ex "# fixed in G""C-1234";                            expect 1 "internal issue reference"
reset; add lib/a.ex "# see g""c2727 run";                               expect 1 "internal issue reference without hyphen"
reset; add lib/a.ex "branch g""c/6835-x";                               expect 1 "internal branch name"
for a in CLAUDE.md AGENTS.md .claude/x .serena/x ".dev""man/x" .planning/x .cursor/x .swarm/x; do
  reset; add "$a" 'x';                                                 expect 1 "AI-tool artefact $a"
done
reset; add _bmad-output/x.md 'x';                                      expect 1 "planning artefact"
reset; add PARITY_AUDIT.md 'x';                                        expect 1 "root working paper"
reset; add lib/a.ex 'client = "Acmecorp"'; EXTRA='acmecorp'            expect 1 "extra (secret) pattern"
reset; add lib/a.ex 'client = "Acmecorp"'; EXTRA=$' acmecorp \r'      expect 1 "extra pattern with CR and padding still matches"
EXTRA=''
reset; add "lib/odd \"näme\".ex" "path = \"/Us""ers/someone/x\"";        expect 1 "file with special characters in its name"
reset; add lib/a.ex "defmodule A, do: nil"; EXTRA="("                    expect 1 "invalid pattern fails closed"
reset; add lib/a.ex "ip = \"192.""168.1.1\" # public-guard: allow (fixture)";   expect 0 "allow marker exempts its own line"
lan="192.""168.1.1"
reset; add lib/a.ex "# public-guard: allow (fixture)"$'\n'"ip = \"$lan\"";                 expect 0 "allow marker on the line above exempts"
reset; add lib/a.ex "# public-guard: allow (fixture)"$'\n\n'"ip = \"$lan\"";             expect 1 "allow marker two lines above does not exempt"
reset; add lib/a.ex "host = \"172.""16.4.2\"";                        expect 1 "private 172.16/12 address"
reset; add lib/a.ex "host = \"172.""32.4.2\"";                        expect 0 "public 172.32.x is not private"
reset; add lib/a.ex "a = \"$lan\" # public-guard: allow (fixture)"$'\n'"b = \"$lan\"";   expect 1 "trailing marker does not exempt the next line"
reset; add lib/a.ex "# public-guard: allow"$'\n'"ip = \"$lan\"";                            expect 1 "marker without a reason does not exempt"
reset; add lib/a.ex "# public-guard: allow"; add lib/b.ex "ip = \"192.""168.1.1\""; expect 1 "allow marker does not exempt other lines"
reset; add lib/a.ex 'c = "Acmecorp" # public-guard: allow (fixture)'; EXTRA='acmecorp' expect 1 "allow marker never exempts an extra pattern"
EXTRA=''
reset; add lib/a.ex 'defmodule A, do: nil'; REQUIRE=1                     expect 1 "required extras missing fails"
reset; add lib/a.ex 'defmodule A, do: nil'; EXTRA='acmecorp'             expect 0 "required extras present passes"
REQUIRE=''; EXTRA=''
reset; add lib/a.ex 'defmodule A, do: nil'; XFILE="$work/missing.txt"    expect 1 "unreadable extras file fails"
XFILE=''
reset; add READINESS.md "x"; add DEVELOPMENT.md "y";                    expect 0 "READINESS and DEVELOPMENT are standard files"
EXTRA=""

# Repo-local literal allowlist (.public-guard-allow). Only exact, whole tokens are
# removed before extra patterns are matched; the allow file is not a scan exemption.
allowfile() { printf '%s\n' "$@" > .public-guard-allow; git add .public-guard-allow; }
reset; allowfile 'ALLOWED_TOKEN'; add lib/a.ex 'v = "ALLOWED_TOKEN"'; EXTRA='allowed_token' expect 0 "allowlisted exact token passes"
reset; allowfile 'ALLOWED_TOKEN'; add lib/a.ex 'v = "ALLOWED_TOKEN"; c = "Acmecorp"'; EXTRA=$'allowed_token\nacmecorp' expect 1 "allowlisted token does not hide a second extra term"
reset; allowfile 'ALLOWED_TOKEN'; add lib/a.ex 'v = "ALLOWED_TOKEN_EXTRA"'; EXTRA='allowed_token' expect 1 "token containing an allowlisted token as a substring still fails"
reset; allowfile 'ALLOWED_TOKEN'; add lib/a.ex 'v = "allowed_token"'; EXTRA='allowed_token' expect 1 "differently-cased allowlisted token is not removed and still fails"
reset; allowfile 'ALLOWED_TOKEN'; add lib/a.ex 'v = "ALLOWED_TOKEN"; c = "AcMeCorp"'; EXTRA='acmecorp' expect 1 "differently-cased extra term on an allowlisted line still fails"
reset; allowfile 'ALLOWED_TOKEN'; add lib/a.ex 'v = "ALLOWED_TOKEN ALLOWED_TOKEN"'; EXTRA='allowed_token' expect 0 "adjacent allowlisted tokens are all removed"
# Accepted limitation: the whole allowlisted token is removed before extra patterns
# are matched, so an extra pattern occurring only inside such a token is invisible.
# That is acceptable because the allowlist holds only our own public identifiers
# (daemon env vars and work/workflow tool names), so a term matching inside one is
# part of a reviewed public identifier; whole-token removal is also what lets
# adjacent allowlisted tokens pass.
reset; allowfile 'ALLOWED_TOKEN'; add lib/a.ex 'v = "ALLOWED_TOKEN"'; EXTRA='token' expect 0 "term embedded inside an allowlisted token is not detected (accepted limitation)"
reset; add lib/a.ex 'v = "ALLOWED_TOKEN"'; EXTRA='allowed_token' expect 1 "no allow file means no allowance"
reset; add .public-guard-allow ''; add lib/a.ex 'v = "ALLOWED_TOKEN"'; EXTRA='allowed_token' expect 1 "empty allow file means no allowance"
reset; add .public-guard-allow "path = \"/Us""ers/someone/x\""; add lib/a.ex 'x'; expect 1 "allow file is still scanned for built-in patterns"
EXTRA=""

# Fail closed: no work tree, or nothing tracked, must never report clean.
reset;                                                                  expect 1 "tree with only the guard tracked fails closed"
reset; git rm -rq --cached .;                                           expect 1 "zero tracked files fails closed"
nonrepo=$(mktemp -d)
outside=$(cd "$nonrepo" && PUBLIC_GUARD_EXTRA='' PUBLIC_GUARD_REQUIRE_EXTRA='' PUBLIC_GUARD_EXTRA_FILE='' \
  bash "$guard" 2>&1); got=$?
rm -rf "$nonrepo"
if [[ $got -eq 0 || "$outside" != *"not inside a git work tree"* ]]; then
  echo "FAIL: guard outside a git work tree (exit $got; output: $outside)"; exit 1
fi
echo "ok: guard refuses to run outside a git work tree"

# A failing `git ls-files` must abort the scan, not be mistaken for an empty tree.
reset; add lib/a.ex 'defmodule A, do: nil'
real_git=$(command -v git)
mkdir -p "$work/bin"
cat > "$work/bin/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [[ "\$a" == ls-files ]]; then
    echo "fatal: public-guard fixture: simulated ls-files failure" >&2
    exit 128
  fi
done
exec "$real_git" "\$@"
EOF
chmod +x "$work/bin/git"
out=$(PATH="$work/bin:$PATH" PUBLIC_GUARD_EXTRA='' PUBLIC_GUARD_REQUIRE_EXTRA='' PUBLIC_GUARD_EXTRA_FILE='' \
  bash scripts/public_guard.sh 2>&1); got=$?
if [[ $got -eq 0 || "$out" != *"public-guard fixture: simulated ls-files failure"* || "$out" == *"public_guard: clean"* || "$out" == *"no scannable tracked files"* ]]; then
  echo "FAIL: failing git ls-files must fail closed (exit $got; output: $out)"; exit 1
fi
echo "ok: failing git ls-files fails closed"
rm -rf "$work/bin"

# pre-push hook: every pushed commit is scanned, not only the tip.
reset; add lib/a.ex 'defmodule A, do: nil'; git commit -qm base; base=$(git rev-parse HEAD)
add lib/a.ex "host = \"$lan\""; git commit -qm leak
add lib/a.ex 'defmodule A, do: nil'; git commit -qm fix
cp "$hook" scripts/pre-push
hookrun() { echo "refs/heads/main $(git rev-parse HEAD) refs/heads/main $1" | \
  PUBLIC_GUARD_EXTRA_FILE="$work/x.txt" bash scripts/pre-push origin >/dev/null 2>&1; }
printf 'acmecorp\r\n' > "$work/x.txt"   # CRLF extras file must still load
hookrun "$base"; got=$?; [[ $got -eq 1 ]] || { echo "FAIL: hook misses a leak in an intermediate commit (exit $got)"; exit 1; }; echo "ok: hook scans intermediate commits"
hookrun deadbeefdeadbeefdeadbeefdeadbeefdeadbeef; got=$?; [[ $got -eq 1 ]] || { echo "FAIL: hook skips a range whose remote sha is unknown (exit $got)"; exit 1; }; echo "ok: hook scans when the remote sha is unknown"
hookrun "$(git rev-parse HEAD~1)"; got=$?; [[ $got -eq 0 ]] || { echo "FAIL: hook rejects a clean range (exit $got)"; exit 1; }; echo "ok: hook passes a clean range"
: > "$work/x.txt"   # readable but empty
hookrun "$(git rev-parse HEAD~1)"; got=$?; [[ $got -eq 1 ]] || { echo "FAIL: hook runs without extras (exit $got)"; exit 1; }; echo "ok: hook requires extras"
rm -f "$work/x.txt"
echo "public_guard_test: all passed"
