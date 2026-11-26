import { describe, it, expect } from 'vitest';
import { splitStreamingBlocks, type StreamingBlocks } from './streamingSplit';
import { chunkedPrefixes, compareWithAlwaysParse, md, perBlockHtml, replyParser } from './streamingSplitTestUtils';

const CHUNKINGS = [[1], [2], [3], [9, 13, 7, 21], [5, 11]];

const worst = (text: string) =>
  CHUNKINGS.map(chunks => {
    const { lagFrames, frames } = compareWithAlwaysParse(chunkedPrefixes(text, chunks));
    return { chunks: chunks.join(','), lagFrames, frames };
  });

describe('settle candidates: pendingLineAt under fuzz', () => {
  const pieces = [
    '- a',
    '-',
    '--',
    '---',
    '- - -',
    '* * *',
    '*',
    '**b**',
    '* e',
    '1',
    '12',
    '1.',
    '1. b',
    '1)',
    '1) c',
    '+ d',
    'para',
    '> q',
    '```\nx\n```',
    '  - nested',
    '  two-space body',
    '   three-space body',
    ' one-space',
    '# h',
  ];
  const seps = ['\n\n', '\n'];
  const texts: string[] = [];
  let seed = 6060;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let t = 0; t < 500; t++) {
    let text = pieces[rnd(pieces.length)];
    for (let k = 0; k < 2 + rnd(6); k++) text += seps[rnd(2)] + pieces[rnd(pieces.length)];
    texts.push(text);
  }

  it('keeps pendingLineAt at the start of the unterminated last line of the tail, also after a cut', () => {
    const bad: string[] = [];
    for (const text of [...texts, 'para\n\n- a\n- b\n\nnext line', 'p1\n\np2\n\n- a\n\n  # x']) {
      for (const chunks of CHUNKINGS) {
        let prev: StreamingBlocks | undefined;
        for (const prefix of chunkedPrefixes(text, chunks)) {
          prev = splitStreamingBlocks(prefix, replyParser, prev);
          const at = prev.pendingLineAt;
          if (at === null) continue;
          const lineStart = prev.tail.lastIndexOf('\n', at - 1) + 1;
          const ok = at >= 0 && at <= prev.tail.length && /^[ \t]*$/.test(prev.tail.slice(lineStart, at));
          if (!ok || prev.tail.indexOf('\n', at) !== -1) bad.push(JSON.stringify(prefix));
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('stale tail list: the list start line stops being a list item', () => {
  const cases: Record<string, string> = {
    'a bold line then loose * items': '**Summary**\n\n* one\n\n* two\n\n* three\n\n* four',
    'a bold line then tight * items': '**Summary**\n\n* one\n* two\n* three\n* four',
    'a --- break then - items': 'intro\n\n---\n\n- one\n- two\n- three',
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`settles the node before the list as soon as always-parse does: ${name}`, () => {
      expect(worst(text).filter(r => r.lagFrames > 0)).toEqual([]);
    });
  }
});

describe('a list ended by an indented line that is not its continuation', () => {
  const steps = (body: (n: number) => string) =>
    Array.from({ length: 4 }, (_, i) => `${i + 1}. Step ${i + 1}:\n\n${body(i + 1)}`).join('\n\n');
  const cases: Record<string, string> = {
    'numbered steps with 2-space bodies': steps(n => `  run task ${n}`),
    'numbered steps with 2-space indented fences': steps(n => `  \`\`\`bash\n  npm run task-${n}\n  \`\`\``),
    'a bullet list split by a 1-space paragraph': '- a\n\n b para\n\n- c\n\n- d\n\n- e',
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`does not lag always-parse: ${name}`, () => {
      expect(worst(text).filter(r => r.lagFrames > 0)).toEqual([]);
    });
  }
});

describe('a spaced thematic break of the same marker below a list', () => {
  for (const [name, text] of Object.entries({
    '- - - under a - list': '- a\n- b\n\n- - -\n\n- c\n- d\n\n- - -\n\n- e',
    '* * * under a * list': '* a\n* b\n\n* * *\n\n* c\n* d',
  })) {
    it(`does not lag always-parse: ${name}`, () => {
      expect(worst(text).filter(r => r.lagFrames > 0)).toEqual([]);
    });
  }
});

describe('deferred shapes still render like the single parse at completion', () => {
  it('matches the single parse after the final split', () => {
    const texts = [
      '**Summary**\n\n* one\n\n* two\n\n* three',
      'intro\n\n---\n\n- one\n- two',
      '1. Step:\n\n  ```bash\n  npm i\n  ```\n\n2. Next:\n\n  ```bash\n  npm t\n  ```\n\nDone.',
      '- a\n- b\n\n- - -\n\n- c',
    ];
    for (const text of texts) {
      for (const chunks of CHUNKINGS) {
        let prev: StreamingBlocks | undefined;
        for (const prefix of chunkedPrefixes(text, chunks)) prev = splitStreamingBlocks(prefix, replyParser, prev);
        const done = splitStreamingBlocks(text, replyParser, prev, true);
        expect(done.blocks.join('') + done.tail).toBe(text);
        expect(perBlockHtml(done)).toBe(md(text));
      }
    }
  });
});
