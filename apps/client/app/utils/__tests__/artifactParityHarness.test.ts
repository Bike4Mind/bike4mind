// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseArtifactsWithFallback as newFallback } from '@client/app/utils/artifactParser';
import { convertCodeBlocksToArtifacts as newCoreConvert } from '@bike4mind/utils/artifactParser';
import {
  convertCodeBlocksToArtifacts as oldClientConvert,
  parseArtifacts as oldParse,
  parseArtifactsWithFallback as oldFallback,
} from './legacyArtifactParser/client';
import { convertCodeBlocksToArtifacts as oldCoreConvert } from './legacyArtifactParser/core';

// Old-vs-new parity harness for the artifact detection merge. The legacy copies are frozen
// at the pre-merge commit; the "new" side is the live code. Order of artifacts is compared
// separately from this file, so results are sorted here.

type Result = ReturnType<typeof newFallback>;

interface NormalizedResult {
  cleanedContent: string;
  artifacts: string[];
}

// Legacy ids come from Date.now(); the merged pass derives them from content. Both are
// "a tool output chart/diagram", so they collapse to one token.
function normalizeIdentifier(id: string | undefined): string | undefined {
  if (id === undefined) return id;
  return id
    .replace(/^(recharts|mermaid)-\d{10,}$/, '$1-<tool-output>')
    .replace(/^(recharts|mermaid)-tool-[0-9a-z]+$/, '$1-<tool-output>');
}

function normalizeResult(result: Result): NormalizedResult {
  const artifacts = result.artifacts
    .map(a => ({
      type: a.type,
      identifier: normalizeIdentifier(a.identifier),
      title: a.title,
      language: a.language,
      content: a.content,
      operation: a.operation,
    }))
    .map(a => JSON.stringify(a))
    .sort();
  return { cleanedContent: result.cleanedContent, artifacts };
}

const F = '```';
const LINE_SEPARATOR = String.fromCharCode(0x2028);

const rechartsTool = JSON.stringify({
  result: JSON.stringify({
    type: 'recharts',
    content: { chartType: 'BarChart', data: [{ a: 1 }] },
    metadata: { title: 'T' },
  }),
});
const mermaidDirect = '{"type":"mermaid","content":"graph TD\\nA-->B"}';
const FLOW = 'flowchart TD\n    A[Start] --> B[End]';
const SEQ =
  'sequenceDiagram\n    participant User\n    participant App\n    User->>App: Request code\n    App-->>User: Code sent';
const REACT_TSX = `${F}tsx\nexport default function App() {\n  const [n] = useState(0);\n  return <div>{n}</div>;\n}\n${F}`;
const DOC = '<!DOCTYPE html>\n<html><head><title>Page</title></head><body><h1>Hi</h1></body></html>';

// Representative inputs harvested from the client and core artifactParser test files.
const HARVESTED: string[] = [
  `${F}html\n<!DOCTYPE html><html><head><title>A "test" <page></title></head><body></body></html>\n${F}`,
  `${F}html\n<div><h1>Hi</h1></div>\n<!-- title tag is in a comment -->\n${F}`,
  `${F}html\n<div><h1>Hi</h1></div>\n<title>Bad<>Title"</title>\n${F}`,
  '<artifact identifier="notes" type="text/markdown" title="Notes">some notes</artifact>',
  '<artifact identifier="x" type="text/html" title="A -> B>content</artifact>',
  `${F}svg\n<svg viewBox="0 0 2 2"><rect width="1" height="1" />\n${F}`,
  `${F}svg\n</svg>\n<svg viewBox="0 0 2 2">\n${F}`,
  `${F}svg\n<svg viewBox="0 0 2 2"><rect width="1" height="1" /></svg>\n${F}`,
  `${F}mermaid\ngraph TD\n  A-->B\n${F}\n\n${F}mermaid\ngraph TD\n  C-->D\n${F}`,
  `${F}mermaid\ngraph TD\n  A-->B${F}`,
  `${F}mermaid\r\ngraph TD\r\n  A-->B\r\n${F}`,
  `${F}mermaid\ngraph TD${LINE_SEPARATOR}  A-->B\n${F}`,
  `${F}mermaid\nflowchart TD\n    A-->B\noption two is better here\n${F}\n`,
  `<artifact identifier="s" type="image/svg+xml" title="S">\n<svg><!-- note --></svg>\n</artifact>`,
  '<artifact identifier="x" title="T">body</artifact>',
  '<artifact identifier="x" type="text/x-unknown" title="T">body</artifact>',
  '<artifact identifier="x" language="python" title="T">print(1)</artifact>',
  '<artifact identifier="x" type="text/html" title="T"><p>hi</p></artifact>',
  `<artifact identifier="x" title="T">body</artifact><artifact identifier="x" type="text/html" title="T2"><p>hi</p></artifact>`,
  `${F}tsx\nconst App = () => null; export default App;\n${F}`,
  `first\n${F}tsx\nexport default function App() { return <i/>; }\n${F}\nmid\n${F}svg\n<svg><rect/></svg>\n${F}\nlast`,
  `${F}jsx\nconst Widget = () => {\n  const [x] = useState(0);\n  return <p>{x}</p>;\n};\n${F}`,
  `${F}tsx\nconst App = 1\nconst B = 2`,
  `<artifact identifier="x" type="text/html" title="X">\n${DOC}\n</artifact>`,
  `<artifact identifier="x" type="text/html" title="X">\n${DOC}\n</artifact>\n\n${DOC}`,
  DOC,
  `<html><body>\n${F}html\n<!DOCTYPE html><html><body><script>var a = 1;</script></body></html>\n${F}\n</body></html>`,
  `Here is what the tool returned:\n\n~~~html b4m-tool-output\n${DOC}\n~~~\n\nDone.`,
  `${F}markdown\n# Notes\n${F}\n\n~~~html b4m-tool-output\n<html><body>1</body></html>\n~~~`,
  `${F}html\n<!DOCTYPE html>\n<html><body><h1>Mine</h1></body></html>\n${F}`,
  `Quoting it:\n\n${F}html\n${DOC}\n${F}\n`,
  `~~~html b4m-tool-output\n<p>never closed</p>`,
  `a\r\n~~~html b4m-tool-output\r\n<html><body>x</body></html>\r\n~~~\r\nb`,
  `Intro\n\n${F}html\n<div class="card"><p>hello</p></div>\n${F}\n\n${F}mermaid\n${FLOW}\n${F}\n\n${REACT_TSX}\n\nDone.`,
  `<artifact identifier="mermaid-1790933427990" type="application/vnd.ant.mermaid" title="Customer Support Ticket Flowchart">\n${FLOW}\n</artifact>\n\n${F}mermaid\ngraph TD\n    X --> Y\n${F}\n`,
  `<artifact identifier="mermaid-1790933536293" type="application/vnd.ant.mermaid" title="Login">\n${SEQ}\n</artifact>Here is the flow.`,
  `Intro\n\n${F}mermaid\n${FLOW}\n${F}\n`,
  `<artifact identifier="a" type="text/plain" title="t">x\n\n${F}mermaid\n${FLOW}\n${F}\n`,
  `<artifact identifier="a" type="text/plain" title="t">\n~~~ b4m-tool-output\nx\n~~~\n</artifact>\n`,
  `see <artifact docs\n<artifact identifier="m" type="application/vnd.ant.mermaid" title="M">\n${FLOW}\n</artifact>\n\n${F}mermaid\n${FLOW}\n${F}\n`,
  `<artifact identifier="a" type="text/html" title="t">\n<pre>\n${F}mermaid\n${FLOW}\n${F}\n</pre>\n</artifact>`,
  `${F}python\nimport os\n\ndef main():\n    print(os.getcwd())\n${F}`,
  `${F}typescript\nimport React, { useState } from 'react';\nfunction C() { const [a] = useState(0); return <div>{a}</div>; }\n${F}`,
  `${F}javascript\nconst x = 1;\nconsole.log(x);\n${F}`,
  `${F}html\n<p>fragment only</p>\n${F}`,
  `${F}html\nplain text no tags\n${F}`,
  `${F}svg\n<svg><rect/></svg>\n${F}\n${F}svg\n<svg><circle/></svg>\n${F}`,
  rechartsTool,
  mermaidDirect,
  `Result: ${rechartsTool}\nand ${mermaidDirect}`,
];

const HAND: string[] = [
  `<artifact identifier="d" type="application/vnd.ant.mermaid" title="D">\n${FLOW}\n</artifact>\n\n${F}mermaid\n${FLOW}\n${F}`,
  `<artifact identifier="md" type="text/markdown" title="Doc">\nIntro\n${F}python\nimport os\n\ndef main():\n    print(1)\n${F}\n</artifact>`,
  `${F}markdown\nOuter\n${F}js\nconsole.log(1);\n${F}\nMore\n${F}js\nlet a = 2;\n${F}\n${F}`,
  '<artifact identifier="u" title="U">x</artifact>',
  rechartsTool,
  mermaidDirect,
  `${F}typescript\nimport React, { useState } from 'react';\nexport default function App() { const [a] = useState(0); return <div>{a}</div>; }\n${F}`,
  `${F}ts\nexport default function App(){ return <div/> }\n${F}`,
  `${F}tsx\nfunction plain() { return 1; }\n${F}`,
  `${F}mermaid\n${FLOW}\n${F}`,
  `${F}python\nimport sys\nx = 1\nprint(x)\n${F}`,
  `${F}python\nprint("hi")\n${F}`,
  `${F}js\nlet unclosed = 1;\n`,
  `${F}html\n${DOC}\n${F}`,
  `${F}svg\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>\n${F}`,
  'Plain prose with no fences at all.',
];

const FIXTURES: string[] = [...HARVESTED, ...HAND];

const SEPARATORS = ['\n\n', '\n', ' ', '\nSome prose.\n'];
const SEED = 20260513;
const N = 5000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildInputs(): string[] {
  const rand = mulberry32(SEED);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const inputs: string[] = [...FIXTURES];
  for (let i = 0; i < N; i++) {
    const count = 1 + Math.floor(rand() * 4);
    const parts: string[] = [];
    for (let j = 0; j < count; j++) parts.push(pick(FIXTURES));
    let out = parts[0];
    for (let j = 1; j < parts.length; j++) out += pick(SEPARATORS) + parts[j];
    inputs.push(out);
  }
  return inputs;
}

interface Mismatch {
  input: string;
  left: NormalizedResult;
  right: NormalizedResult;
}

function collectMismatches(inputs: string[], left: (x: string) => Result, right: (x: string) => Result): Mismatch[] {
  const out: Mismatch[] = [];
  for (const input of inputs) {
    const l = normalizeResult(left(input));
    const r = normalizeResult(right(input));
    if (JSON.stringify(l) !== JSON.stringify(r)) out.push({ input, left: l, right: r });
  }
  return out;
}

function describeMismatches(label: string, mismatches: Mismatch[]): string {
  const shown = mismatches.slice(0, 5).map(m => JSON.stringify(m, null, 2));
  return `${label}: ${mismatches.length} mismatches. First ${shown.length}:\n${shown.join('\n---\n')}`;
}

describe(`artifact detection parity (seed ${SEED}, N=${N})`, () => {
  const inputs = buildInputs();

  it('legacy copies agree with themselves on a trivial case (harness sanity)', () => {
    const x = `${F}mermaid\n${FLOW}\n${F}`;
    expect(oldClientConvert(oldCoreConvert(x))).toContain('<artifact');
    expect(oldParse(oldCoreConvert(x)).artifacts.length).toBeGreaterThan(0);
  });

  it('H1 chat parity: new fallback over new core == old fallback over old core', () => {
    const mismatches = collectMismatches(
      inputs,
      x => newFallback(newCoreConvert(x)),
      x => oldFallback(oldCoreConvert(x))
    );
    expect(mismatches.length, describeMismatches('H1', mismatches)).toBe(0);
  });

  it('H2 stored legacy chat replies render unchanged', () => {
    const mismatches = collectMismatches(
      inputs,
      x => newFallback(oldCoreConvert(x)),
      x => oldFallback(oldCoreConvert(x))
    );
    expect(mismatches.length, describeMismatches('H2', mismatches)).toBe(0);
  });

  // The merge flips this to toBe(0): until then the agent path (no server convert) renders
  // differently from the chat path on some inputs.
  it('H3 agent parity (known gap until the merge)', () => {
    const mismatches = collectMismatches(
      inputs,
      x => newFallback(x),
      x => newFallback(newCoreConvert(x))
    );
    console.log(`H3 mismatches: ${mismatches.length} of ${inputs.length}`);
    expect(mismatches.length, describeMismatches('H3', mismatches)).toBeGreaterThan(0);
  });
});
