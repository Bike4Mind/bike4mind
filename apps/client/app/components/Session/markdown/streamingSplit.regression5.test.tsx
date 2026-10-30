import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { type Options } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import { countSettleCandidates, createBlockParser, splitStreamingBlocks, type StreamingBlocks } from './streamingSplit';

const remarkPlugins: Options['remarkPlugins'] = [...assistantReplyRemarkPlugins];
const rehypePlugins: Options['rehypePlugins'] = [rehypeKatex];
const parse = createBlockParser(remarkPlugins);

const md = (text: string) =>
  text
    ? renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
          {text}
        </ReactMarkdown>
      )
    : '';

const perBlockHtml = (split: StreamingBlocks) => [...split.blocks, split.tail].filter(Boolean).map(md).join('\n');

const chunkedPrefixes = (text: string, chunks: number[]) => {
  const out: string[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    i = Math.min(text.length, i + chunks[k % chunks.length]);
    k++;
    out.push(text.slice(0, i));
  }
  return out;
};

// Same chain twice: as shipped (skip allowed) and with every frame forced to parse.
const compareWithAlwaysParse = (prefixes: string[]) => {
  let skip: StreamingBlocks | undefined;
  let always: StreamingBlocks | undefined;
  let lagFrames = 0;
  let maxLagBytes = 0;
  for (const prefix of prefixes) {
    skip = splitStreamingBlocks(prefix, parse, skip);
    always = splitStreamingBlocks(prefix, parse, always, true);
    const settledSkip = skip.blocks.join('').length;
    const settledAlways = always.blocks.join('').length;
    if (settledAlways > settledSkip) {
      lagFrames++;
      maxLagBytes = Math.max(maxLagBytes, settledAlways - settledSkip);
    }
  }
  return { skip: skip!, always: always!, lagFrames, frames: prefixes.length, maxLagBytes };
};

const charByChar = (text: string) => chunkedPrefixes(text, [1]);

const lastFrame = (prefixes: string[]) => {
  const r = compareWithAlwaysParse(prefixes);
  return { skip: r.skip.blocks.length, always: r.always.blocks.length };
};

describe('skip rule: a new list node below a list is not a candidate', () => {
  const cases: Record<string, string> = {
    'a bullet list after an ordered list': '1. one\n2. two\n\n- alpha\n- beta\n- gamma\n- delta\n- epsilon',
    'a 1) list after a 1. list': '1. one\n2. two\n\n1) alpha\n2) beta\n3) gamma\n4) delta',
    'a * list after a - list': '- one\n- two\n\n* alpha\n* beta\n* gamma\n* delta',
    'a "* * *" break and a list after a list': '- one\n- two\n\n* * *\n\n- alpha\n- beta\n- gamma',
    'a "- - -" break and a list after a list': '1. one\n2. two\n\n- - -\n\n- alpha\n- beta\n- gamma',
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`settles the first list by the last streamed frame: ${name}`, () => {
      const { skip, always } = lastFrame(charByChar(text));
      expect(always).toBeGreaterThan(0);
      expect(skip).toBe(always);
    });
  }

  it('settles numbered steps with column-0 fences under chunked frames', () => {
    const step = (n: number) => `${n}. Step ${n}:\n\`\`\`bash\nnpm run task-${n}\n\`\`\`\n\n`;
    const text = Array.from({ length: 8 }, (_, i) => step(i + 1))
      .join('')
      .trimEnd();
    const { skip, always, frames, lagFrames } = compareWithAlwaysParse(chunkedPrefixes(text, [9, 13, 7, 21]));
    expect({ frames, lagFrames, settledSkip: skip.blocks.length, settledAlways: always.blocks.length }).toEqual({
      frames,
      lagFrames: 0,
      settledSkip: always.blocks.length,
      settledAlways: always.blocks.length,
    });
  });
});

describe('skip rule: numbered steps with column-0 fences, char by char', () => {
  it('settles every finished step when frames add one character', () => {
    const step = (n: number) => `${n}. Step ${n}:\n\`\`\`bash\nnpm run task-${n}\n\`\`\`\n\n`;
    const text = Array.from({ length: 8 }, (_, i) => step(i + 1))
      .join('')
      .trimEnd();
    expect(compareWithAlwaysParse(charByChar(text)).lagFrames).toBe(0);
  });
});

describe('skip rule: a list waits for the next line to end, but no parse runs at that line end', () => {
  const followers: Record<string, string> = {
    'a long fence': '```ts\n' + Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n',
    'a long table': '| a | b |\n|---|---|\n' + Array.from({ length: 30 }, (_, i) => `| ${i} | ${i * 2} |`).join('\n'),
    'a long paragraph': Array.from({ length: 30 }, (_, i) => `sentence ${i}.`).join('\n'),
    heading: '# Head\nmore words',
  };
  for (const [name, follower] of Object.entries(followers)) {
    it(`settles a list followed by ${name} once that node's first line has ended`, () => {
      const text = `- one\n- two\n- three\n\n${follower}`;
      expect(lastFrame(charByChar(text))).toEqual({ skip: 1, always: 1 });
    });
  }
});

describe('skip rule: boundaries after a list that are counted', () => {
  const after: Record<string, string> = {
    heading: '# Head',
    blockquote: '> quoted',
    fence: '```\ncode\n```',
    table: '| a | b |\n|---|---|\n| 1 | 2 |',
    math: '$$\nx^2\n$$',
    'thematic break ***': '***',
    'thematic break ---': '---',
    'html block': '<div>\nhtml\n</div>',
    paragraph: 'plain words',
  };
  for (const [name, block] of Object.entries(after)) {
    it(`has settled the list and the ${name} by the next boundary`, () => {
      const text = `- one\n- two\n- three\n\n${block}\n\nend of reply`;
      expect(lastFrame(charByChar(text))).toEqual({ skip: 2, always: 2 });
    });
  }

  it('does not count indented fences, lazy continuations or footnote continuations, and loses nothing for it', () => {
    const texts = [
      '1. step\n\n   ```\n   code\n\n   more\n   ```\n2. next\n\nend',
      '- item one\nlazy continuation\n- item two\n\nend',
      'Para [^1].\n\n[^1]: note\n\n    continued note\n\nend',
    ];
    for (const text of texts) {
      const r = lastFrame(charByChar(text));
      expect(r.skip).toBe(r.always);
    }
  });
});

const countCandidates = (text: string, prev: StreamingBlocks) => countSettleCandidates(text, prev.tailList);

describe('skip rule: candidate count monotonicity', () => {
  it('never sees the candidate count drop below the stored one on a skip frame', () => {
    const pieces = [
      '- a',
      '1',
      '12',
      '1. b',
      '1) c',
      '+ d',
      '* e',
      'para',
      '- - -',
      '> q',
      '```\nx\n```',
      '  - nested',
    ];
    const seps = ['\n\n', '\n'];
    const drops: string[] = [];
    let seed = 5050;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let t = 0; t < 400; t++) {
      let text = pieces[rnd(pieces.length)];
      for (let k = 0; k < 2 + rnd(5); k++) text += seps[rnd(2)] + pieces[rnd(pieces.length)];
      for (const chunks of [[1], [2], [3], [4, 1]]) {
        let prev: StreamingBlocks | undefined;
        let parsed = false;
        const spy = (s: string) => {
          parsed = true;
          return parse(s);
        };
        for (const prefix of chunkedPrefixes(text, chunks)) {
          parsed = false;
          const next = splitStreamingBlocks(prefix, spy, prev);
          if (!parsed && prev && countCandidates(next.tail, prev) < prev.settleCandidates) {
            drops.push(JSON.stringify(prefix));
          }
          prev = next;
        }
      }
    }
    expect(drops).toEqual([]);
  });
});

describe('final parse catches up whatever the skip rule deferred', () => {
  it('renders like the single parse after completion for the deferred shapes', () => {
    const step = (n: number) => `${n}. Step ${n}:\n\`\`\`bash\nnpm run task-${n}\n\`\`\`\n\n`;
    const texts = [
      '1. one\n2. two\n\n- alpha\n- beta',
      '- one\n\n* * *\n\n- two',
      Array.from({ length: 5 }, (_, i) => step(i + 1)).join('') + 'Done.',
    ];
    for (const text of texts) {
      let prev: StreamingBlocks | undefined;
      for (const prefix of chunkedPrefixes(text, [9, 13, 7, 21])) prev = splitStreamingBlocks(prefix, parse, prev);
      const done = splitStreamingBlocks(text, parse, prev, true);
      expect(done.blocks.join('') + done.tail).toBe(text);
      expect(perBlockHtml(done)).toBe(md(text));
    }
  });
});

describe('cut at line start', () => {
  const probes: Record<string, string> = {
    'indented code block after a paragraph': 'intro\n\n    const a = 1;\n    const b = 2;\n\nend',
    'tab-indented code block after a paragraph': 'intro\n\n\tconst a = 1;\n\tconst b = 2;\n\nend',
    'space and tab indented code block': 'intro\n\n  \tconst a = 1;\n\nend',
    'heading indented 3': 'intro\n\n   ## Head\n\nend',
    'fence indented 3 with tab content': 'intro\n\n   ```\n   \tx\n   ```\n\nend',
    'definition indented 2': 'intro\n\n  [r]: https://example.com\n\nsee [r]',
  };
  for (const [name, text] of Object.entries(probes)) {
    it(`cuts only whitespace before the node and renders like the single parse: ${name}`, () => {
      let prev: StreamingBlocks | undefined;
      const prefixes = charByChar(text);
      for (const prefix of prefixes) {
        const next = splitStreamingBlocks(prefix, parse, prev);
        expect(next.blocks.join('') + next.tail).toBe(prefix);
        prev = next;
      }
      const done = splitStreamingBlocks(text, parse, prev, true);
      const nodeStarts = (parse(text).children ?? []).map(n => n.position!.start.offset);
      let at = 0;
      for (const block of done.blocks) {
        at += block.length;
        const start = nodeStarts.find(s => s >= at)!;
        expect(text.slice(at, start)).toMatch(/^[ \t]*$/);
      }
      if (!done.crossBlock) expect(perBlockHtml(done)).toBe(md(text));
    });
  }
});

describe('crossBlock on skip frames', () => {
  it('keeps reporting a definition in the unsettled tail on frames that skip the parse', () => {
    const text = '- item\n\n  [r]: https://example.com\n\nSee [r] in the next paragraph';
    let prev: StreamingBlocks | undefined;
    const flips: number[] = [];
    let seen = false;
    for (const prefix of charByChar(text)) {
      prev = splitStreamingBlocks(prefix, parse, prev);
      if (prev.crossBlock) seen = true;
      else if (seen) flips.push(prefix.length);
    }
    expect(flips).toEqual([]);
  });

  it('sees a definition nested in a list item that settled mid-stream', () => {
    const text = '- item\n\n  [r]: https://example.com\n\n- more\n\nPara with [r].\n\nend';
    let prev: StreamingBlocks | undefined;
    for (const prefix of chunkedPrefixes(text, [4, 7])) prev = splitStreamingBlocks(prefix, parse, prev);
    expect(prev!.settledCrossBlock).toBe(true);
    expect(splitStreamingBlocks(text, parse, prev, true).crossBlock).toBe(true);
  });
});
