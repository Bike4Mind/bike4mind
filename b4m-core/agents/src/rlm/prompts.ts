/**
 * System-prompt fragments explaining the persistent REPL tool to a
 * ReAct agent. Adapted in spirit from Appendix C of the RLM paper
 * (arXiv:2512.24601) and rewritten for our JS idioms + actual tool
 * surface.
 *
 * GENERIC. Domain-specific tool-descriptor sets (e.g., a product's
 * data-lake tools, tavern read-only tools) live with their respective
 * domain code and are passed in via the `tools` argument.
 */

/** Descriptor for an in-REPL tool - used to render the tool list. */
export interface ReplToolDescriptor {
  /** JS function name as exposed inside the REPL. */
  name: string;
  /** Short signature like `({ query, top_k = 10 })` or `(file_id)`. */
  signature: string;
  /** One-line purpose. */
  description: string;
}

/** Optional injection: corpus stats (article count, embedding model, etc.). */
export interface CorpusStats {
  totalArticles: number;
  totalChunks: number;
  embeddingModel: string;
}

export interface BuildReplPromptOpts {
  tools?: ReplToolDescriptor[];
  corpusStats?: CorpusStats;
}

/** Build the system-prompt fragment dynamically based on which tools are wired. */
export function buildReplToolSystemPrompt(opts: BuildReplPromptOpts = {}): string {
  const tools = opts.tools ?? [];
  const sections: string[] = [];

  sections.push(`## You have a persistent JavaScript REPL — the \`code_execute\` tool

When you call the \`code_execute\` tool, the JavaScript you submit runs in
a V8 context that PERSISTS for your entire session. Variables you create
without \`let\`/\`const\`/\`var\` (i.e., implicit-global assignment) survive
across turns.

Inside \`code_execute\` you have access to ordinary JavaScript (Math, JSON,
Date, Array, Object, Map, Set, etc., plus \`console.log\` for output).`);

  if (tools.length > 0) {
    const toolLines = tools.map(t => `- \`${t.name}${t.signature}\`\n  ${t.description}`).join('\n\n');
    sections.push(`### Async functions exposed inside the REPL

Each of these is the same tool you can also call directly via the
agent's tool-call interface — but inside \`code_execute\` you can call
them in loops, store their results in variables, and aggregate
programmatically.

${toolLines}`);
  } else {
    sections.push(`### Async functions exposed inside the REPL

(None today — the REPL has only standard JavaScript. You can still
use it for computation, classification by pattern-matching, and
multi-turn state via implicit-global assignment.)`);
  }

  if (opts.corpusStats) {
    const s = opts.corpusStats;
    sections.push(`### Corpus stats (current snapshot)

- Total articles: ${s.totalArticles}
- Total vectorized chunks: ${s.totalChunks}
- Embedding model: ${s.embeddingModel}`);
  }

  sections.push(`### When to reach for \`code_execute\` vs. a direct tool call

Use a **direct tool call** when:
- You need exactly one piece of information ("find the pricing policy doc").
- The task is single-hop and a tool result is your final answer.

Use **\`code_execute\`** when:
- You need to iterate over many items ("for each candidate, classify by ...").
- You want to cache intermediate state across turns (build up a buffer,
  refine it, query it).
- You need to programmatically aggregate, filter, or pair items
  (contradiction detection, coverage matrices, RFP synthesis).
- A direct loop in code would be 10× cheaper than asking the agent to
  call a tool per item.`);

  // The subAgentQuery sermon - only relevant if it's wired in
  if (tools.some(t => t.name === 'subAgentQuery')) {
    sections.push(`### When to reach for \`subAgentQuery\` (USE THIS — it's why the REPL exists)

If the task involves **classifying, extracting, or comparing more than 3
items**, use \`subAgentQuery\` inside a loop. Do NOT try to do the
classification yourself across many items in a single response — you'll
either truncate the data or hallucinate. The whole reason \`subAgentQuery\`
exists is to let you delegate per-item work to a fast cheap model
(Haiku) and reason over the *aggregated results* in your own context.

Concrete signals you should be using subAgentQuery:
- "For each chunk, what does it say about X?"
- "Group these N items by category."
- "Which of these N claims contradict each other?" (use it to label
  each, then enumerate pairs in plain code)
- "Extract the timeline year from each of these N pitch documents."

A typical T2 / T3 trajectory looks like:
1. \`semanticSearch\` (or \`keywordSearch\`) to get N candidate chunks
2. Loop over the N candidates, calling \`subAgentQuery\` on each to
   extract / classify / verify
3. Aggregate the per-chunk results in plain JS (filter / group / pair)
4. \`console.log\` a compact summary
5. Return a final answer based on the summary

If you find yourself thinking "let me just look at all these chunks and
figure it out myself," stop — write a subAgentQuery loop. It's faster,
cheaper, and produces more reliable results.`);
  }

  // Code patterns - universal
  sections.push(`### Patterns

1. **Cache + refine** — first turn builds a buffer, later turns query
   it without re-fetching:

\`\`\`js
// turn 1
catalog = ${
    tools.some(t => t.name === 'listArticles')
      ? `(await listArticles({ tag: "product:family:scheduling", limit: 200 })).data;
console.log("indexed", catalog.length, "articles");

// turn 2 (same session — catalog still alive)
const recent = catalog.filter(a => new Date(a.createdAt) > new Date("2025-01-01"));
console.log("recent:", recent.map(a => a.fileName).slice(0, 5));`
      : `[/* whatever you computed */];

// turn 2 — catalog still in scope
const summary = catalog.filter(x => x.relevant).slice(0, 5);
console.log(summary);`
  }
\`\`\`

${
  tools.some(t => t.name === 'subAgentQuery')
    ? `2. **Chunk-and-classify** — pull semantically similar chunks, classify
   each via a sub-LLM, group by category:

\`\`\`js
const hits = await semanticSearch({ query: "product roadmap timeline", top_k: 30 });
buckets = {};
for (const h of hits.results) {
  const stance = await subAgentQuery({
    prompt: \`In one phrase, what stance does this take on the near-term roadmap?\\n\\n\${h.chunk_text.slice(0, 1500)}\`,
  });
  (buckets[stance] ??= []).push(h.file_name);
}
Object.entries(buckets).forEach(([k, v]) => console.log(\`\${k}: \${v.length}\`));
\`\`\`

3. **Programmatic pair enumeration** — find conflicting claims across
   tag-filtered candidates:

\`\`\`js
const candidates = (await semanticSearch({ query: "portfolio strategy", top_k: 20 })).results;
contradictions = [];
for (let i = 0; i < candidates.length; i++) {
  for (let j = i + 1; j < candidates.length; j++) {
    const verdict = await subAgentQuery({
      prompt: \`Do these two snippets contradict each other? Reply YES or NO with one-line reason.\\n\\nA: \${candidates[i].chunk_text.slice(0, 800)}\\n\\nB: \${candidates[j].chunk_text.slice(0, 800)}\`,
    });
    if (verdict.startsWith("YES")) contradictions.push([i, j, verdict]);
  }
}
console.log(JSON.stringify(contradictions, null, 2));
\`\`\``
    : ''
}`);

  sections.push(`### Discipline

- Variables PERSIST across turns IF you assign without \`let\`/\`const\`/\`var\`.
- \`console.log\` output is captured and returned to you. Long output is
  truncated to 5K head + 2K tail; print summaries, not full corpora.
- If a code block throws, your variables still persist — just fix and
  re-run.
- When you have a final answer, emit it as your normal response (do
  NOT put it inside an \`code_execute\` call — the user can't see code
  output as your final reply).`);

  return sections.join('\n\n').trim();
}
