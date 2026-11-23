#!/usr/bin/env bash
# Record grim's JSON output for every artifact kind against a private zot.
# Usage: record-kinds.sh <grim-binary> <output-dir>
# Env:   ZOT (a zot registry binary), GRIMOIRE_SRC (a grimoire checkout, for its
#        catalog hook), GRIM_COMMIT (stamped into recorded.json), KEEP_RUN=1.
# Needs jq, curl, git and python3. Writes nothing outside a temp dir and <output-dir>.
set -euo pipefail

[[ $# -eq 2 ]] || { echo "usage: $0 <grim-binary> <output-dir>" >&2; exit 2; }
GRIM=$(realpath "$1")
OUT=$(realpath -m "$2")
ZOT=${ZOT:?set ZOT to a zot binary}
GRIMOIRE_SRC=${GRIMOIRE_SRC:?set GRIMOIRE_SRC to a grimoire checkout}
[[ -x $GRIM && -x $ZOT ]] || { echo "grim or zot binary not executable" >&2; exit 2; }

RUN=$(realpath "$(mktemp -d)")
HOME_DIR=$RUN/home          # becomes /home/u
PROJECT=$HOME_DIR/project   # becomes /home/u/project
SRC=$RUN/src
RAW=$RUN/raw
mkdir -p "$SRC" "$RAW"
: >"$RAW/exits.txt"
ZOT_PID=""

cleanup() {
  local rc=$?
  if [[ -n $ZOT_PID ]]; then kill "$ZOT_PID" 2>/dev/null || true; wait "$ZOT_PID" 2>/dev/null || true; fi
  if [[ -n ${INDEX_PID:-} ]]; then kill "$INDEX_PID" 2>/dev/null || true; fi
  [[ ${KEEP_RUN:-0} == 1 ]] || rm -rf "$RUN"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- zot on a random loopback port (config shape from grim's test/src/zot.py)
start_zot() {
  local port
  for _ in 1 2 3 4 5; do
    port=$((20000 + RANDOM % 30000))
    cat >"$RUN/zot.json" <<JSON
{"distSpecVersion":"1.1.1","storage":{"rootDirectory":"$RUN/zot-data","gc":false,"dedupe":false},
 "http":{"address":"127.0.0.1","port":"$port"},"log":{"level":"error"}}
JSON
    "$ZOT" serve "$RUN/zot.json" >"$RUN/zot.log" 2>&1 &
    ZOT_PID=$!
    for _ in $(seq 1 100); do
      kill -0 "$ZOT_PID" 2>/dev/null || break
      if curl -fsS "http://127.0.0.1:$port/v2/" >/dev/null 2>&1; then PORT=$port; return 0; fi
      sleep 0.2
    done
    kill "$ZOT_PID" 2>/dev/null || true; wait "$ZOT_PID" 2>/dev/null || true; ZOT_PID=""
  done
  echo "zot did not start" >&2; return 1
}
start_zot
REG=localhost:$PORT
NS=$REG/acme
ZOT_VERSION=$("$ZOT" --version 2>&1 | jq -r '.commit // empty' 2>/dev/null | head -n1 || true)
ZOT_VERSION=${ZOT_VERSION:-unknown}

# ---- sandboxed grim: every variable that could reach outside RUN is pinned,
# every other GRIM_*/OCX_* is dropped by env -i.
g() {
  env -i PATH="$PATH" LANG=C.UTF-8 NO_COLOR=1 \
    HOME="$HOME_DIR" GRIM_HOME="$HOME_DIR/.grimoire" \
    CLAUDE_CONFIG_DIR="$HOME_DIR/.claude" XDG_CONFIG_HOME="$HOME_DIR/.config" \
    OPENCODE_CONFIG_DIR="$HOME_DIR/.config/opencode" CODEX_HOME="$HOME_DIR/.codex" \
    DOCKER_CONFIG="$HOME_DIR/.docker" GRIM_INSECURE_REGISTRIES="$REG" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    "$GRIM" "$@"
}

# rec <name> <grim args...>: run in the project, keep stdout as <name>.json and the exit code.
rec() {
  local name=$1 code=0
  shift
  (cd "$PROJECT" && g "$@") >"$RAW/$name.json" 2>"$RAW/$name.err" </dev/null || code=$?
  printf '%s %s\n' "$name" "$code" >>"$RAW/exits.txt"
}
# quiet <grim args...>: a setup step, not recorded; must succeed.
quiet() { (cd "$PROJECT" && g "$@") >>"$RAW/setup.log" 2>&1 </dev/null; }

# ---- artifact sources
ref() { printf '%s/%s:1.0.0' "$NS" "$1"; }

mkdir -p "$SRC/skills/code-review" "$SRC/rules" "$SRC/agents" "$SRC/mcp" "$SRC/hooks/tool-call-logger" \
  "$SRC/settings" "$SRC/bundles"
cat >"$SRC/skills/code-review/SKILL.md" <<'MD'
---
name: code-review
description: Review a diff for correctness, security and style, and report findings by severity.
metadata:
  summary: Structured diff review
  keywords: review,quality,diff
---
# Code review

Read the diff, then report each finding with a file, a line and a fix.
MD
cat >"$SRC/rules/rust-style.md" <<'MD'
---
paths:
  - "**/*.rs"
summary: Idiomatic Rust style rules
keywords: rust,style,lints
---
# Rust style

Prefer `?` over `unwrap` outside tests.
MD
cat >"$SRC/agents/reviewer.md" <<'MD'
---
name: reviewer
description: Delegate a pull request review to this agent.
metadata:
  summary: Pull request reviewer
  keywords: review,agent,pr
---
You are a careful reviewer. Report specific, actionable findings only.
MD
cat >"$SRC/mcp/docs-search.toml" <<'TOML'
description = "Search the team documentation over MCP."
summary = "Team docs search"
keywords = "docs,search,mcp"

[server]
transport = "stdio"
command = "docs-search"
args = ["serve"]
TOML
cp "$GRIMOIRE_SRC/catalog/hooks/tool-call-logger/hook.toml" \
  "$GRIMOIRE_SRC/catalog/hooks/tool-call-logger/log.sh" \
  "$SRC/hooks/tool-call-logger/"
cat >"$SRC/settings/team-defaults.toml" <<'TOML'
description = "Team defaults for Claude Code: a model and permission rules."
summary = "Team defaults"
keywords = "team,defaults,permissions"

[claude]
model = "sonnet"

[claude.permissions]
allow = ["Bash(git status:*)"]
deny = ["Bash(rm:*)"]
TOML
cat >"$SRC/bundles/starter.toml" <<TOML
summary = "Starter pack"
keywords = "starter,review,style"
description = "The code-review skill plus the Rust style rule"

[skills]
code-review = "$(ref code-review)"

[rules]
rust-style = "$(ref rust-style)"
TOML
# summary/keywords only where the binary's mod schema has them (older builds refuse them).
MOD_META=""
if g schema --kind mod 2>/dev/null | jq -e '.properties.summary' >/dev/null 2>&1; then
  MOD_META='summary = "Build status band"\nkeywords = "ci,status,band"\n'
fi
mk_mod() { # <name> <entry>
  mkdir -p "$SRC/mods/$1/claude" "$SRC/mods/$1/opencode"
  printf "schema = 1\nname = \"%s\"\ndescription = \"%s\"\n$MOD_META\n[claude]\nentry = \"%s.tsx\"\n" \
    "$1" "Build status above the prompt" "$1" >"$SRC/mods/$1/mod.toml"
  printf 'export default {}\n' >"$SRC/mods/$1/claude/$1.tsx"
  printf 'export default {}\n' >"$SRC/mods/$1/opencode/$1.ts"
}
mk_mod status-band
mk_mod extra-band

# ---- publish. The release runs from a scratch project with the flags on.
mkdir -p "$HOME_DIR/project" "$HOME_DIR/.claude"
release() { # <name> <path> [--kind k]
  local name=$1 path=$2
  shift 2
  quiet release "$path" "$(ref "$name")" "$@"
}
cat >"$PROJECT/grimoire.toml" <<TOML
[options.experimental]
hooks = true
settings = true
mods = true
TOML
release code-review "$SRC/skills/code-review"
release rust-style "$SRC/rules/rust-style.md"
release reviewer "$SRC/agents/reviewer.md" --kind agent
release docs-search "$SRC/mcp/docs-search.toml" --kind mcp
release starter "$SRC/bundles/starter.toml"
release tool-call-logger "$SRC/hooks/tool-call-logger"
release team-defaults "$SRC/settings/team-defaults.toml" --kind settings
release status-band "$SRC/mods/status-band"
release extra-band "$SRC/mods/extra-band"

# ---- project helpers
write_config() { # <mods flag> [extra toml appended]
  cat >"$PROJECT/grimoire.toml" <<TOML
[[registries]]
alias = "acme"
oci = "$NS"
default = true
insecure = true

[options.experimental]
hooks = true
settings = true
mods = $1

[options.vendors.opencode]
plugin_api = "v2"
TOML
  [[ -z ${2:-} ]] || printf '\n%s\n' "$2" >>"$PROJECT/grimoire.toml"
}
fresh_project() { # <mods flag> [extra toml]
  rm -rf "$HOME_DIR"
  mkdir -p "$PROJECT/.claude" "$PROJECT/.opencode" "$HOME_DIR/.claude" "$HOME_DIR/.config/opencode" \
    "$HOME_DIR/.codex" "$HOME_DIR/.docker"
  git -C "$PROJECT" init -q -b main
  write_config "$@"
}
mod_decl="[mods]
status-band = \"$(ref status-band)\""

# ---- phase A: per kind
KINDS=(skill rule agent mcp bundle hook settings mod)
declare -A NAME=([skill]=code-review [rule]=rust-style [agent]=reviewer [mcp]=docs-search
  [bundle]=starter [hook]=tool-call-logger [settings]=team-defaults [mod]=status-band)
fresh_project true
for k in "${KINDS[@]}"; do
  n=${NAME[$k]}
  rec "$k-search" search --format json "$n"
  rec "$k-describe" describe --format json "$(ref "$n")"
  rec "$k-fetch" fetch --format json "$(ref "$n")"
  case $k in
    hook | settings | mod) rec "$k-add" add --format json --trust-workspace "$(ref "$n")" ;;
    *) rec "$k-add" add --format json "$(ref "$n")" ;;
  esac
  rec "$k-status" status --format json
done
rec search-all search --format json
rec context context --format json

# ---- index-backed search: one all.json pointer per kind, built from describe
INDEX=$RUN/index
mkdir -p "$INDEX"
for k in "${KINDS[@]}"; do cat "$RAW/$k-describe.json"; done | jq -s '[.[] | {
    schema: 1, name, kind, ref: ("ghcr.io/acme/" + .name), description,
    repository: "https://github.com/acme/skills", owner: {github: "acme", id: 1},
    summary: .annotations["com.grimoire.summary"],
    keywords: ((.annotations["com.grimoire.keywords"] // "") | split(",") | map(select(. != "")))
  } + (if .kind == "mod" then {serves} else {} end)
  | with_entries(select(.value != null and .value != []))]' >"$INDEX/all.json"
IPORT=$((20000 + RANDOM % 30000))
python3 -m http.server --bind 127.0.0.1 --directory "$INDEX" "$IPORT" >"$RUN/index.log" 2>&1 &
INDEX_PID=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$IPORT/all.json" >/dev/null 2>&1 && break; sleep 0.2; done
fresh_project true
cat >"$PROJECT/grimoire.toml" <<TOML
[[registries]]
alias = "hub"
index = "http://127.0.0.1:$IPORT"
default = true
TOML
rec index-search-all search --format json --refresh
kill "$INDEX_PID" 2>/dev/null || true
wait "$INDEX_PID" 2>/dev/null || true

# ---- install-all: all eight declared, one consent answer, bare install
fresh_project true "[skills]
code-review = \"$(ref code-review)\"

[rules]
rust-style = \"$(ref rust-style)\"

[agents]
reviewer = \"$(ref reviewer)\"

[mcp]
docs-search = \"$(ref docs-search)\"

[bundles]
starter = \"$(ref starter)\"

[hooks]
tool-call-logger = \"$(ref tool-call-logger)\"

[settings]
team-defaults = \"$(ref team-defaults)\"

$mod_decl"
quiet lock
quiet hook allow
rec install-all install --format json

# ---- phase B: mod states
mod_project() { fresh_project "$1" "$mod_decl"; quiet lock; }

mod_project false
rec mod-status-flag-off status --format json

mod_project true
rec mod-install-not-consented install --format json
rec mod-status-not-consented status --format json

mod_project true
quiet install --trust-workspace
rec mod-status-installed status --format json

# files-tracked: git tracks a file grim wrote
entry=$(cd "$PROJECT" && find .claude/mods/status-band/src -type f | sort | head -n1)
git -C "$PROJECT" add -f "$entry"
rec mod-status-files-tracked status --format json

# disabled-in-client: enabledPlugins entry false
mod_project true
quiet install --trust-workspace
settings=$PROJECT/.claude/settings.local.json
jq '.enabledPlugins |= with_entries(if (.key|startswith("status-band@")) then .value=false else . end)' \
  "$settings" >"$settings.new" && mv -f "$settings.new" "$settings"
rec mod-status-disabled-in-client status --format json

# uninstall
mod_project true
quiet install --trust-workspace
rec mod-uninstall uninstall --format json mod status-band

# files-present: consented, never written, files sit at the expected path
mod_project true
quiet hook allow
mkdir -p "$PROJECT/.claude/mods/status-band/src"
printf '// hand made\n' >"$PROJECT/.claude/mods/status-band/src/status-band.tsx"
rec mod-status-files-present status --format json

# hook allow report
mod_project true
rec mod-hook-allow hook allow --format json

# drifted: a second mod keeps the record non-empty, then status-band's key is dropped
fresh_project true "$mod_decl
extra-band = \"$(ref extra-band)\""
quiet lock
quiet hook allow
quiet install
record=$(find "$HOME_DIR/.grimoire/consent" -name '*.json' | head -n1)
jq '.sources |= map(select(startswith("status-band@")|not))' "$record" >"$record.new" && mv -f "$record.new" "$record"
quiet install
rec mod-status-drifted status --format json

# ---- sanitize and write
rm -rf "$OUT"
mkdir -p "$OUT"
for f in "$RAW"/*.json; do
  n=$(basename "$f" .json)
  sed -e "s#$HOME_DIR#/home/u#g" -e "s#$RUN#/home/u/run#g" -e "s#$REG/acme#ghcr.io/acme#g" -e "s#$REG#ghcr.io#g" \
    -e "s#http://127.0.0.1:${IPORT:-0}#https://index.acme.dev#g" \
    "$f" >"$OUT/$n.json"
  jq -e . "$OUT/$n.json" >/dev/null || { echo "not JSON: $n.json" >&2; exit 1; }
done
jq -Rn '[inputs | split(" ") | {(.[0]): (.[1] | tonumber)}] | add' "$RAW/exits.txt" >"$OUT/exits.json"
GV=$(g --version | awk '{print $2}')
jq -n --arg v "$GV" --arg c "${GRIM_COMMIT:-unknown}" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg z "zot $ZOT_VERSION" \
  '{grim_version: $v, grim_commit: $c, recorded_at: $t, script: "record-kinds.sh", registry: $z}' >"$OUT/recorded.json"
if grep -rlE "$HOME_DIR|$RUN|/tmp/|localhost:$PORT|127\.0\.0\.1:" "$OUT"; then echo "unsanitized path left" >&2; exit 1; fi
echo "recorded $(find "$OUT" -name '*.json' | wc -l) files to $OUT"
