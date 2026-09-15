import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';

const prompt = readFileSync(join(__dirname, 'prompt.txt'), 'utf8');
const cases = require('./cases.cjs');
const reference = require('./reference.cjs');
const outDir = join(__dirname, 'out');
mkdirSync(outDir, { recursive: true });

// Models to test (only those installed are run; others are skipped with a note).
// Defaults use the exact tags `ollama list` reports, so the installed-check matches.
const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'NitrAI/VibeThinker-3B:latest',
      'qwen3.5:9b',
      'qwen2.5-coder:32b',
      'qwen3-coder:30b',
      'qwen3.6:27b',
      'glm-4.7-flash:latest',
      'gpt-oss:120b',
    ];

// Fetch installed models, failing loudly if Ollama isn't reachable.
async function fetchInstalled() {
  let res;
  try {
    res = await fetch(`${OLLAMA}/api/tags`);
  } catch (e) {
    console.error(`Could not reach Ollama at ${OLLAMA} — is it running? (${e.message})`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Ollama ${OLLAMA}/api/tags returned HTTP ${res.status}.`);
    process.exit(1);
  }
  const data = await res.json();
  return new Set((data.models || []).map((m) => m.name));
}
const installed = await fetchInstalled();

function stripThink(s) {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, '');
}
// Robust extraction: a markdown fence is ``` at the START of a line. Backticks
// inside code (e.g. a fence-matching regex) appear mid-line and must NOT be
// treated as fences. Collect line-fenced blocks, then prefer the one that
// actually defines the function.
function extractCode(text) {
  const t = stripThink(text);
  const lines = t.split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (cur === null) cur = [];
      else {
        blocks.push(cur.join('\n'));
        cur = null;
      }
    } else if (cur !== null) {
      cur.push(line);
    }
  }
  if (cur !== null) blocks.push(cur.join('\n')); // unclosed fence — keep what we have
  if (blocks.length === 0) return t;
  const named = blocks.filter((b) => /ensureToolPairingIntegrity|module\.exports/.test(b));
  const pool = named.length ? named : blocks;
  return pool.sort((a, b) => b.length - a.length)[0];
}

let loadCounter = 0;
async function loadCandidate(code) {
  loadCounter++;
  const isESM = /\bexport\s+(?:default|const|function|\{)/.test(code) && !/module\.exports/.test(code);
  if (isESM) {
    const f = join(outDir, `cand_${loadCounter}.mjs`);
    writeFileSync(f, code);
    const mod = await import(pathToFileURL(f).href + `?t=${loadCounter}`);
    return mod.ensureToolPairingIntegrity || mod.default?.ensureToolPairingIntegrity || mod.default;
  }
  const f = join(outDir, `cand_${loadCounter}.cjs`);
  writeFileSync(f, code);
  delete require.cache[require.resolve(f)];
  const mod = require(f);
  return mod.ensureToolPairingIntegrity || mod.default?.ensureToolPairingIntegrity || mod.default;
}

// Deep clone via JSON round-trip — test inputs are plain JSON-serializable data.
const clone = (x) => JSON.parse(JSON.stringify(x));

function grade(fn) {
  let passed = 0;
  const detail = [];
  for (const c of cases) {
    try {
      const inputForCand = clone(c.input);
      const before = JSON.stringify(inputForCand);
      const got = fn(inputForCand);
      const expected = reference.ensureToolPairingIntegrity(clone(c.input));
      assert.deepStrictEqual(got, expected);
      if (/do not mutate/.test(c.name) && JSON.stringify(inputForCand) !== before) {
        throw new Error('mutated input');
      }
      passed++;
      detail.push(`  ✓ ${c.name}`);
    } catch (e) {
      detail.push(`  ✗ ${c.name} — ${String(e.message).split('\n')[0].slice(0, 80)}`);
    }
  }
  return { passed, total: cases.length, detail };
}

async function callModel(model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900_000);
  const t0 = Date.now();
  // stream:true so bytes flow continuously — avoids undici's 300s headersTimeout
  // on slow/verbose reasoning models that take >5min to finish a buffered response.
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      // Generous budget so reasoning models can finish thinking AND answer
      options: { temperature: 0.2, num_ctx: 16384, num_predict: 16000 },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  let content = '';
  let thinking = '';
  let evalCount = 0;
  let evalDur = 0;
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.message?.content) content += j.message.content;
      if (j.message?.thinking) thinking += j.message.thinking;
      if (j.done) {
        evalCount = j.eval_count ?? evalCount;
        evalDur = (j.eval_duration ?? 0) / 1e9;
      }
    }
  }
  const wallSec = (Date.now() - t0) / 1000;
  const tps = evalDur > 0 ? evalCount / evalDur : 0;
  return { content, thinking, wallSec, evalCount, tps };
}

const results = [];
for (const model of MODELS) {
  if (!installed.has(model)) {
    console.log(`\n— ${model}: NOT INSTALLED, skipping`);
    results.push({ model, skipped: true });
    continue;
  }
  process.stdout.write(`\n=== ${model} … `);
  try {
    const r = await callModel(model);
    writeFileSync(
      join(outDir, `${model.replace(/[\/:]/g, '_')}.raw.txt`),
      r.content + (r.thinking ? `\n\n----- [thinking] -----\n${r.thinking}` : '')
    );
    // Prefer a code block in content; fall back to thinking if content has none.
    const hasFenceInContent = /```/.test(stripThink(r.content));
    const code = extractCode(hasFenceInContent ? r.content : r.content + '\n' + r.thinking);
    let g = { passed: 0, total: cases.length, detail: ['  (code failed to load)'] };
    let loadErr = null;
    try {
      const fn = await loadCandidate(code);
      if (typeof fn !== 'function') throw new Error('no ensureToolPairingIntegrity export');
      g = grade(fn);
    } catch (e) {
      loadErr = String(e.message).split('\n')[0].slice(0, 90);
    }
    console.log(`${r.wallSec.toFixed(1)}s, ${r.tps.toFixed(0)} tok/s ===`);
    console.log(g.detail.join('\n'));
    if (loadErr) console.log(`  load error: ${loadErr}`);
    results.push({ model, passed: g.passed, total: g.total, wallSec: r.wallSec, tps: r.tps, loadErr });
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    results.push({ model, error: String(e.message).slice(0, 100) });
  }
}

// Scoreboard
console.log('\n\n================= SCOREBOARD =================');
const rank = results
  .filter((r) => !r.skipped && !r.error)
  .sort((a, b) => b.passed - a.passed || a.wallSec - b.wallSec);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('MODEL', 26), pad('SCORE', 8), pad('TIME', 9), pad('TOK/S', 7));
console.log('-'.repeat(52));
for (const r of rank) {
  console.log(
    pad(r.model, 26),
    pad(`${r.passed}/${r.total}`, 8),
    pad(`${r.wallSec.toFixed(1)}s`, 9),
    pad(r.tps.toFixed(0), 7),
    r.loadErr ? `  ⚠ ${r.loadErr}` : ''
  );
}
for (const r of results.filter((r) => r.skipped)) console.log(pad(r.model, 26), 'SKIPPED (not installed)');
for (const r of results.filter((r) => r.error)) console.log(pad(r.model, 26), `ERROR: ${r.error}`);
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log('\nRaw model outputs + results.json saved to:', outDir);
