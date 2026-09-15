# -*- coding: utf-8 -*-
# Renders a "cool" text chart of the B4M local-LLM shootout.

# (model, size, score, time_s, tok_s, tag)
rows = [
    ("qwen2.5-coder:32b", "19GB",  10, 32,   22,  ""),
    ("glm-4.7-flash",     "19GB",  10, 45,   76,  ""),
    ("gpt-oss:120b",      "65GB",  10, 45,   66,  ""),
    ("VibeThinker-3B",    "3.3GB", 10, 74,   104, "tiny!"),
    ("qwen3.6:27b",       "17GB",  10, 298,  22,  ""),
    ("deepseek-r1:70b",   "42GB",  10, 576,  9,   ""),
    ("qwen3-coder:30b",   "18GB",  4,  7.2,  111, "fastest"),
    ("qwen3.5:9b",        "6.6GB", 0,  249,  64,  "DNF"),
]
medals = ["1.", "2.", "3.", " 4", " 5", " 6", " 7", " 8"]
EIGHTHS = " ▏▎▍▌▋▊▉█"

def bar(frac, width):
    frac = max(0.0, min(1.0, frac))
    total = frac * width
    full = int(total)
    rem = total - full
    s = "█" * full
    if full < width:
        s += EIGHTHS[int(rem * 8)]
    return s.ljust(width)

W = 78
line = "─" * W
top = "═" * W

print("╔" + top + "╗")
print("║" + "  B4M LOCAL-LLM SHOOTOUT  ·  task: ensureToolPairingIntegrity (10 cases)".ljust(W) + "║")
print("║" + "  rig: Apple M4 Max · 128 GB · Ollama 0.30".ljust(W) + "║")
print("╚" + top + "╝")
print()
print("  CORRECTNESS  (filled = cases passed / 10)")
print("  " + line)
for m, sz, sc, t, tps, tag in rows:
    medal = medals[rows.index((m, sz, sc, t, tps, tag))]
    b = bar(sc / 10, 10)
    label = ("⭐ " + tag) if tag == "tiny!" else ("⚡ " + tag) if tag == "fastest" else ("✖ " + tag) if tag == "DNF" else ""
    print("  %s %-17s %-6s │%s│ %2d/10   %s" % (medal, m, sz, b, sc, label))
print("  " + line)
print()
print("  GENERATION SPEED  (tokens / sec — higher = snappier)")
print("  " + line)
mx = max(r[4] for r in rows)
for m, sz, sc, t, tps, tag in sorted(rows, key=lambda r: -r[4]):
    print("  %-17s %s %3d t/s" % (m, bar(tps / mx, 30), tps))
print("  " + line)
print()
print("  WALL-CLOCK TIME TO ANSWER  (log scale — shorter = faster; ✓=correct ✗=wrong)")
print("  " + line)
import math
mxt = math.log10(max(r[3] for r in rows))
mnt = math.log10(min(r[3] for r in rows))
for m, sz, sc, t, tps, tag in sorted(rows, key=lambda r: r[3]):
    frac = (math.log10(t) - mnt) / (mxt - mnt)
    mark = "✓" if sc == 10 else "✗"
    print("  %-17s %s %5.1fs %s" % (m, bar(frac, 30), t, mark))
print("  " + line)
print()
print("  TAKEAWAY: 6/8 nailed 10/10. The 3.3 GB VibeThinker tied the 65 GB & 42 GB")
print("  giants and BEAT the 18 GB coder-specialist (qwen3-coder, 4/10, killed by a")
print("  Set-identity bug). Params != correctness. Speed king qwen3-coder needs a")
print("  test-feedback loop to redeem its 111 t/s.")
