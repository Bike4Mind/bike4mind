import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
const FN = 'parseQuestResponse';

const prompt = readFileSync(join(__dirname, 'prompt2.txt'), 'utf8');
const cases = require('./cases2.cjs');
const outDir = join(__dirname, 'out2');
mkdirSync(outDir, { recursive: true });

const MODELS = process.argv.slice(2);
if (MODELS.length === 0) {
  console.error(
    'Usage: node eval2.mjs <model-tag> [<model-tag> ...]\n' +
      'Use exact tags from `ollama list` (e.g. glm-4.7-flash:latest, NitrAI/VibeThinker-3B:latest).'
  );
  process.exit(1);
}

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

const stripThink = (s) => s.replace(/<think>[\s\S]*?<\/think>/gi, '');
// Robust extraction: a markdown fence is ``` at the START of a line. Backticks
// inside code (e.g. the regex /^```json?/ that this very task asks models to
// write) appear mid-line and must NOT be treated as fences. Collect line-fenced
// blocks, then prefer the one that actually defines the function.
function extractCode(text) {
  const t = stripThink(text);
  const lines = t.split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (cur === null) cur = [];
      else { blocks.push(cur.join('\n')); cur = null; }
    } else if (cur !== null) {
      cur.push(line);
    }
  }
  if (cur !== null) blocks.push(cur.join('\n')); // unclosed fence — keep what we have
  if (blocks.length === 0) return t;
  const named = blocks.filter((b) => /parseQuestResponse|module\.exports/.test(b));
  const pool = named.length ? named : blocks;
  return pool.sort((a, b) => b.length - a.length)[0];
}

let n = 0;
async function loadCandidate(code) {
  n++;
  const isESM = /\bexport\s+(?:default|const|function|\{)/.test(code) && !/module\.exports/.test(code);
  if (isESM) {
    const f = join(outDir, `cand_${n}.mjs`);
    writeFileSync(f, code);
    const mod = await import(pathToFileURL(f).href + `?t=${n}`);
    return mod[FN] || mod.default?.[FN] || mod.default;
  }
  const f = join(outDir, `cand_${n}.cjs`);
  writeFileSync(f, code);
  delete require.cache[require.resolve(f)];
  const mod = require(f);
  return mod[FN] || mod.default?.[FN] || mod.default;
}

function grade(fn) {
  let passed = 0;
  const detail = [];
  for (const c of cases) {
    try {
      const got = fn(c.input); // a throw here = automatic fail (rule 6: never throw)
      assert.deepStrictEqual(got, c.expected);
      passed++;
      detail.push(`  ✓ ${c.name}`);
    } catch (e) {
      const msg = e instanceof assert.AssertionError ? 'wrong output' : `THREW: ${e.message}`;
      detail.push(`  ✗ ${c.name} — ${String(msg).split('\n')[0].slice(0, 70)}`);
    }
  }
  return { passed, total: cases.length, detail };
}

async function callModel(model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900_000);
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      // Hard task — give reasoning models generous headroom so a long chain of
      // thought can still finish AND emit a final answer (glm spiraled past 16k).
      options: { temperature: 0.2, num_ctx: 40960, num_predict: 32000 },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  let content = '', thinking = '', evalCount = 0, evalDur = 0, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.message?.content) content += j.message.content;
      if (j.message?.thinking) thinking += j.message.thinking;
      if (j.done) { evalCount = j.eval_count ?? evalCount; evalDur = (j.eval_duration ?? 0) / 1e9; }
    }
  }
  const wallSec = (Date.now() - t0) / 1000;
  const tps = evalDur > 0 ? evalCount / evalDur : 0;
  return { content, thinking, wallSec, tps };
}

const results = [];
for (const model of MODELS) {
  if (!installed.has(model)) { console.log(`\n— ${model}: NOT INSTALLED`); results.push({ model, skipped: true }); continue; }
  process.stdout.write(`\n=== ${model} … `);
  try {
    const r = await callModel(model);
    writeFileSync(join(outDir, `${model.replace(/[\/:]/g, '_')}.raw.txt`),
      r.content + (r.thinking ? `\n\n----- [thinking] -----\n${r.thinking}` : ''));
    const hasFence = /```/.test(stripThink(r.content));
    const code = extractCode(hasFence ? r.content : r.content + '\n' + r.thinking);
    let g = { passed: 0, total: cases.length, detail: [] }, loadErr = null;
    try {
      const fn = await loadCandidate(code);
      if (typeof fn !== 'function') throw new Error(`no ${FN} export`);
      g = grade(fn);
    } catch (e) { loadErr = String(e.message).split('\n')[0].slice(0, 90); }
    console.log(`${r.wallSec.toFixed(1)}s, ${r.tps.toFixed(0)} tok/s ===`);
    console.log(g.detail.join('\n'));
    if (loadErr) console.log(`  load error: ${loadErr}`);
    results.push({ model, passed: g.passed, total: g.total, wallSec: r.wallSec, tps: r.tps, loadErr });
  } catch (e) { console.log(`ERROR: ${e.message}`); results.push({ model, error: String(e.message).slice(0, 100) }); }
}

console.log('\n\n============ HARD MODE SCOREBOARD (parseQuestResponse · 10 cases) ============');
const rank = results.filter((r) => !r.skipped && !r.error).sort((a, b) => b.passed - a.passed || a.wallSec - b.wallSec);
const pad = (s, w) => String(s).padEnd(w);
console.log(pad('MODEL', 26), pad('SCORE', 8), pad('TIME', 9), pad('TOK/S', 7));
console.log('-'.repeat(54));
for (const r of rank) console.log(pad(r.model, 26), pad(`${r.passed}/${r.total}`, 8), pad(`${r.wallSec.toFixed(1)}s`, 9), pad(r.tps.toFixed(0), 7), r.loadErr ? `⚠ ${r.loadErr}` : '');
for (const r of results.filter((r) => r.skipped)) console.log(pad(r.model, 26), 'SKIPPED');
for (const r of results.filter((r) => r.error)) console.log(pad(r.model, 26), `ERROR: ${r.error}`);
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log('\nSaved to:', outDir);
