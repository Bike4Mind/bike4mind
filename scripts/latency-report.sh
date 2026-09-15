#!/usr/bin/env bash
# latency-report.sh — Decode QuestProcessor (LLM completion) latency from local SST logs.
#
# SST dev writes per-invocation logs to .sst/log/lambda/QuestProcessor/<epoch>-<id>.log.
# This script finds the relevant log (newest by default, or by quest id) and prints a
# clean latency breakdown: the completion.started request summary, every ⏱️ phase marker,
# the Pipeline phases line, and a few derived headline metrics.
#
# Usage:
#   scripts/latency-report.sh                 # newest QuestProcessor invocation
#   scripts/latency-report.sh <questId>       # specific quest id
#   scripts/latency-report.sh --list          # list recent invocations (newest first)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$ROOT/.sst/log/lambda/QuestProcessor"
strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }

[ -d "$LOGDIR" ] || { echo "No QuestProcessor logs at $LOGDIR (is SST dev running?)" >&2; exit 1; }

if [ "${1:-}" = "--list" ]; then
  echo "Recent QuestProcessor invocations (newest first):"
  # shellcheck disable=SC2012
  ls -t "$LOGDIR"/*.log 2>/dev/null | head -15 | while read -r f; do
    q=$(strip_ansi <"$f" | grep -m1 -oE 'questId: [a-fA-F0-9]+' | awk '{print $2}')
    printf '  %s  quest=%s\n' "$(basename "$f")" "${q:-?}"
  done
  exit 0
fi

if [ -n "${1:-}" ]; then
  F=$(grep -rl "$1" "$LOGDIR" 2>/dev/null | head -1 || true)
  [ -n "$F" ] || { echo "No QuestProcessor log found for quest '$1'" >&2; exit 1; }
else
  # shellcheck disable=SC2012
  F=$(ls -t "$LOGDIR"/*.log 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "No QuestProcessor logs found" >&2; exit 1; }
fi

echo "=== Log: $(basename "$F") ==="
echo

echo "--- Request summary (completion.started) ---"
strip_ansi <"$F" | grep -m1 '"detail-type":"completion.started"' \
  | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const m=s.match(/\{.*\}/s);const e=JSON.parse(m[0]).detail||{};const p=e.params||{};
        console.log(`  model:        ${p.model}`);
        console.log(`  maxTokens:    ${p.max_tokens}  temp: ${p.temperature}  stream: ${p.stream}`);
        console.log(`  historyCount: ${e.historyCount}`);
        console.log(`  enabledTools: ${JSON.stringify(e.tools||[])}`);
        console.log(`  mcpServers:   ${JSON.stringify(e.mcpServers||[])}`);
        console.log(`  enableAgents: ${e.enableAgents}  enableQuestMaster: ${e.enableQuestMaster}`);
      }catch(err){console.log("  (could not parse request)")}
    });' 2>/dev/null || echo "  (no completion.started event in this log)"
echo

echo "--- ⏱️ timing markers ---"
strip_ansi <"$F" | grep '⏱️' | sed -E 's/^\[[0-9T:.Z-]+\] +INFO //'
echo

echo "--- 📊 Pipeline phases ---"
strip_ansi <"$F" | grep -A1 'Pipeline phases' | tail -1
echo

PRUNED=$(strip_ansi <"$F" | grep -c 'Failed to send message to connection' || true)
echo "--- Derived ---"
echo "  stale websocket connections pruned during request: ${PRUNED}"
