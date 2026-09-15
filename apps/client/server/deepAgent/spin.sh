#!/usr/bin/env bash
#
# Deep Agent spin harness — exercise the wake loop without copy-pasting curls.
#
#   ./spin.sh 1                 # research + compute demo
#   ./spin.sh 2                 # pure compute (sandboxed REPL)
#   ./spin.sh 3                 # paper-repro: research + compute + evidence tiers
#   ./spin.sh "your goal here"           # custom goal, default role
#   ./spin.sh "your goal here" paper-repro   # custom goal + role
#
# Env: BASE_URL (default http://localhost:3001), B4M_LOCAL_API_KEY (required).
# Watch your `sst dev` terminal alongside for the live [deepAgent.wake]/[deepAgent.act] trajectory.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
: "${B4M_LOCAL_API_KEY:?set B4M_LOCAL_API_KEY (run: source ~/.zsh-secrets)}"

G1="Use web_search to find Anthropic Claude Opus current API price per million input and output tokens, then use code_execute to compute the monthly cost of 3M input + 1M output tokens/day over 30 days. Show the arithmetic."
G2="Use code_execute to find all primes below 100000, then report their count, mean gap, and the largest prime gap, with the algorithm used."
G3="Research a standard approximation-algorithm bound, then use code_execute to simulate a small toy model and report one numerical observation. Be explicit about engineering-proxy vs paper-facing evidence."

# Build the JSON payload in python so goals with quotes/newlines are safe.
payload() { # $1=role $2=goal
  python3 -c 'import json,sys; print(json.dumps({"role": sys.argv[1], "enableTools": True, "goal": sys.argv[2]}))' "$1" "$2"
}

case "${1:-1}" in
  1) BODY="$(payload default "$G1")" ;;
  2) BODY="$(payload default "$G2")" ;;
  3) BODY="$(payload paper-repro "$G3")" ;;
  *) BODY="$(payload "${2:-default}" "$1")" ;;
esac

echo "▶ POST $BASE_URL/api/deep-agent/spin"
echo "  $BODY" | cut -c1-160
echo

curl -s --max-time 180 -X POST "$BASE_URL/api/deep-agent/spin" \
  -H "x-api-key: $B4M_LOCAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print("non-JSON response:\n" + raw[:2000]); sys.exit(0)
if "error" in d:
    print("ERROR: " + str(d["error"])[:1500]); sys.exit(0)
ep = d.get("episode", {})
ch = d.get("charter", {})
ho = d.get("handoff", {})
print("agentId:      " + str(d.get("agentId")))
print("latency:      %s ms | act tokens: %s | tools: %s" % (d.get("latency_ms"), ep.get("tokensSpent"), d.get("enableTools")))
print("policy:       " + str(ep.get("policy", {}).get("actionKind")))
print("tool calls:   " + str([a.get("tool") for a in ep.get("actionsTaken", [])]))
print("scope locks:  %s | memory added: %s | charter v%s%s" % (
    len(ep.get("scopeLocks", [])), ch.get("semanticMemoryCount"), ch.get("version"),
    " (groomed)" if ch.get("groomed") else ""))
fa = [o["summary"] for o in ep.get("observations", []) if o.get("kind") == "final_answer"]
print("\n--- final answer ---\n" + (fa[0] if fa else "(none)"))
print("\n--- next intended action ---\n" + str(ho.get("nextIntendedAction") or "(none)"))
'
