# Local-LLM Eval Harness

An objective, auto-graded head-to-head for **local open-weight models served by [Ollama](https://ollama.com)**, scored on **real Bike4Mind coding tasks** rather than benchmark marketing. Each model is given the identical spec one-shot, writes the function in CommonJS, and is graded by running its code against a ground-truth test suite.

> ⚠️ **Safety — this harness executes model-generated code.** Each candidate's output is written to disk and loaded via `require()` / `import()`, so it runs with **full Node privileges** (filesystem + network), unsandboxed. Only run it against models you trust, and prefer a throwaway/sandboxed checkout rather than an environment holding credentials or secrets. The graded inputs are local string fixtures — no network calls are made on the model's behalf — but the code itself is not isolated.

## Why

"Which local model should we run in B4MCLI / Claude Code?" is a question benchmark leaderboards answer poorly — they don't tell you how a model does on _our_ code. This harness runs candidates against actual B4M logic and grades pass/fail + latency + tokens/sec, so the answer is grounded in our own prompts.

## Tasks

| File | Task | What it probes |
|------|------|----------------|
| `prompt.txt` + `cases.cjs` + `reference.cjs` | **Round 1 — `ensureToolPairingIntegrity`** (from `b4m-core/llm-adapters`): repair Anthropic tool_use/tool_result pairing | Pure-function correctness; a subtle object-identity `Set` trap |
| `prompt2.txt` + `cases2.cjs` + `reference2.cjs` | **Round 2 — `parseQuestResponse`** (the `tavern/generate-quests` fix for issue #8022): robustly parse untrusted LLM output | Defensive parsing — prose, fences, JSON buried in text, a decoy `{placeholder}` brace, never throwing |

Each round has 10 cases. The `reference*.cjs` files are correct ground-truth implementations used to (a) verify the suite is internally consistent and (b) anchor expected outputs.

## Running

Requires Node 18+ and a running Ollama daemon (`http://localhost:11434`).

```bash
# Round 1 (pass model tags as args; defaults to a built-in list if omitted)
node eval.mjs qwen2.5-coder:32b glm-4.7-flash:latest gpt-oss:120b

# Round 2 (hard mode)
node eval2.mjs qwen2.5-coder:32b glm-4.7-flash:latest qwen3-coder:30b

# Pretty text chart of the recorded results
python3 chart.py
```

Use the **exact** tag from `ollama list` (e.g. `glm-4.7-flash:latest`, `NitrAI/VibeThinker-3B:latest`). Raw model outputs and a `results.json` are written to `out/` (Round 1) and `out2/` (Round 2), both git-ignored.

### Harness notes

- **Streaming** (`stream: true`) is used so slow/verbose reasoning models don't trip Node's 300s `fetch` header-timeout on buffered responses.
- **Reasoning headroom**: a generous `num_predict` budget lets a long chain of thought still finish _and_ emit a final answer (some reasoning models otherwise spiral past the cap with no answer).
- **Code extraction** treats ` ``` ` as a fence only at line-start, so a model that legitimately writes a fence-matching regex (e.g. `/^```json?/`) inside its code isn't truncated.
- **Grading** runs each candidate on `structuredClone`d inputs and deep-equals against the reference; Round 1 also catches input mutation, Round 2 counts any thrown exception as a failure (the spec requires "never throw").

## Results (Apple M4 Max · 128 GB · Ollama 0.30)

| Model | Size | Round 1 (easy) | Round 2 (hard) |
|-------|------|:--------------:|:--------------:|
| `qwen2.5-coder:32b` | 19 GB | 10/10 | 10/10 |
| `glm-4.7-flash` | 19 GB | 10/10 | 10/10 |
| `gpt-oss:120b` | 65 GB | 10/10 | 10/10 |
| `qwen3.6:27b` | 17 GB | 10/10 | 10/10 |
| `deepseek-r1:70b` | 42 GB | 10/10 | 10/10 |
| `qwen3-coder:30b` | 18 GB | 4/10 | 9/10 |
| `VibeThinker-3B` | 3.3 GB | 10/10 | 4/10 |
| `qwen3.5:9b` | 6.6 GB | 0/10 | 0/10 |

**Takeaways:** `qwen2.5-coder:32b` is the only 10/10-both pick and the fastest to a correct answer — the daily driver. `glm-4.7-flash` is its co-equal but reasons heavily (needs ~2× the token budget). `qwen3-coder:30b` is dramatically faster but cuts corners on the hardest edge case one-shot. The standalone visual report is in `scoreboard.html` (open in a browser).

Add a model by passing its tag; add a Round 3 by copying the `prompt/cases/reference` trio and pointing a new `evalN.mjs` at it.
