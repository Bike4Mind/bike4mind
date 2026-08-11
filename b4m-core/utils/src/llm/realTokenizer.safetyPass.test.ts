import { describe, it, expect, vi } from 'vitest';
import { buildAndSortMessages, calculateTotalTokenLength, getLastBuildDebugInfo } from './utils';
import { TiktokenTokenizer } from '../tokenCounting';
import type { IMessage } from '@bike4mind/common';

/**
 * The rest of the suite mocks the tokenizer at a fixed chars/token, which is exactly the assumption the
 * bug lived inside: the estimator assumes 3.5 while real content does not. Measured with cl100k_base on
 * the fixtures below, the CSV runs 2.36 chars/token and the prose 6.02, so the estimator under-counts
 * data by a third and over-counts prose by nearly half. A payload only clears the budget on estimate and
 * blows it on real tokens when the HISTORY is data-shaped too, which is why an all-prose conversation
 * has enough slack to hide the whole thing.
 *
 * So this file asserts the promise in the units that matter, against the same function production
 * measures with. Baseline when it was written: 7 of these 15 rows fail against main.
 *
 * Fixtures are generated with varying values rather than a repeated character on purpose - a
 * single-character repeat collapses into very few tiktoken merges and encodes orders of magnitude
 * slower for the same length, which turns a 200ms file into an 8s one.
 */

const logger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  updateMetadata: vi.fn(),
};

// One instance for the file so every row shares the encoder cache; constructing it per row reloads WASM.
const tokenizer = new TiktokenTokenizer({ logger: logger as never });

const ASK = 'ASK-MARKER what does the attached data say about region-7';
const DECLARED = 'could not be included in this request';
const TRUNCATED = '[Content truncated to fit the context window';

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** 2.36 chars/token under cl100k_base, against the estimator's 3.5: the density it under-counts. */
const csv = (rows: number, seed = 0): string =>
  Array.from(
    { length: rows },
    (_, i) =>
      `${seed + i},user${seed + i}@example.com,${((seed + i) * 7919) % 100000},2026-0${((seed + i) % 9) + 1}-1${
        (seed + i) % 9
      },region-${(seed + i) % 13},${((seed + i) * 31) % 997}.${((seed + i) * 7) % 99}`
  ).join('\n');

/** 6.02 chars/token: the density the estimator over-counts, which is what hides an overflow. */
const prose = (sentences: number, seed = 0): string =>
  Array.from(
    { length: sentences },
    (_, i) =>
      `Considering the quarterly position for region ${(seed + i) % 13}, the reconciliation team noted that ` +
      `settlement volumes moved by ${((seed + i) * 3) % 47} percent against a forecast that assumed steady ` +
      `demand throughout the period, which the committee had already flagged as optimistic.`
  ).join(' ');

const attachment = (fileName: string, body: string): IMessage => ({
  role: 'user',
  content: `Here is the content from the attached file "${fileName}" for context:\n\n${body}`,
});

const historyOf = (turns: number, body: (i: number) => string): IMessage[] =>
  Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: body(i),
  }));

const imageMessage = (chars: number): IMessage => ({
  role: 'user',
  content: [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Array.from({ length: Math.ceil(chars / 8) }, (_, i) => `q${(i * 37) % 10}Zx${(i * 11) % 10}Ab`).join(''),
      },
    },
  ] as unknown as IMessage['content'],
});

const toolUseHistory = (turns: number): IMessage[] => [
  ...historyOf(turns, i => csv(120, i * 120)),
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} }] as unknown as IMessage['content'],
  },
];

const toolResultPrompt: IMessage[] = [
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] as unknown as IMessage['content'],
  },
  { role: 'user', content: ASK },
];

type Row = {
  name: string;
  history: IMessage[];
  content: IMessage[];
  prompt?: IMessage[];
  maxInputTokens: number;
  /** The all-prose control: nothing should be cut, so the pass must not have run at all. */
  untouched?: boolean;
};

const rows: Row[] = [
  // (a) Dense CSV history plus a CSV attachment, at two real small-model windows. The reachable shape.
  {
    name: 'dense csv history + csv attachment at 5144',
    history: historyOf(8, i => csv(140, i * 140)),
    content: [attachment('roster.csv', csv(900))],
    maxInputTokens: 5144,
  },
  {
    name: 'dense csv history + csv attachment at 3096',
    history: historyOf(8, i => csv(140, i * 140)),
    content: [attachment('roster.csv', csv(900))],
    maxInputTokens: 3096,
  },
  {
    name: 'dense csv history dominating a small attachment',
    history: historyOf(16, i => csv(200, i * 200)),
    content: [attachment('roster.csv', csv(120))],
    maxInputTokens: 5144,
  },
  {
    name: 'csv history with no attachment at all',
    history: historyOf(20, i => csv(180, i * 180)),
    content: [],
    maxInputTokens: 4096,
  },
  // (b) An image-carrying overflow. Sized so content can absorb it: an overflow made mostly of images
  // cannot be shrunk by any branch, which is the give-up case covered in utils.test.ts.
  {
    name: 'image alongside a csv attachment',
    history: historyOf(6, i => csv(100, i * 100)),
    content: [attachment('roster.csv', csv(700)), imageMessage(40000)],
    maxInputTokens: 8192,
  },
  {
    name: 'two images alongside a csv attachment',
    history: historyOf(4, i => prose(3, i)),
    content: [attachment('roster.csv', csv(700)), imageMessage(20000), imageMessage(20000)],
    maxInputTokens: 8192,
  },
  // (c) Several attachments at once, mixing densities so the estimator errs both ways on one turn.
  {
    name: 'three attachments mixing csv and prose',
    history: historyOf(8, i => csv(120, i * 120)),
    content: [
      attachment('roster.csv', csv(500)),
      attachment('notes.txt', prose(30)),
      attachment('ledger.csv', csv(500, 5000)),
    ],
    maxInputTokens: 5144,
  },
  {
    name: 'five attachments, csv heavy',
    history: historyOf(6, i => csv(100, i * 100)),
    content: [
      attachment('a.csv', csv(300)),
      attachment('b.csv', csv(300, 1000)),
      attachment('c.csv', csv(300, 2000)),
      attachment('d.txt', prose(20)),
      attachment('e.csv', csv(300, 3000)),
    ],
    maxInputTokens: 4096,
  },
  {
    name: 'one very large attachment against a small window',
    history: historyOf(4, i => prose(2, i)),
    content: [attachment('huge.csv', csv(4000))],
    maxInputTokens: 3096,
  },
  {
    name: 'prose attachment with csv history',
    history: historyOf(14, i => csv(160, i * 160)),
    content: [attachment('notes.txt', prose(60))],
    maxInputTokens: 5144,
  },
  // The tool-call turn: the other assembly order, driven to overflow.
  {
    name: 'tool-call turn overflowing',
    history: toolUseHistory(6),
    content: [attachment('roster.csv', csv(600))],
    prompt: toolResultPrompt,
    maxInputTokens: 5144,
  },
  {
    name: 'tool-call turn overflowing at a smaller window',
    history: toolUseHistory(8),
    content: [attachment('roster.csv', csv(600))],
    prompt: toolResultPrompt,
    maxInputTokens: 3096,
  },
  // Mixed history: prose turns interleaved with pasted data, which is what a real session looks like.
  {
    name: 'history alternating prose and pasted csv',
    history: historyOf(12, i => (i % 2 === 0 ? prose(4, i) : csv(150, i * 150))),
    content: [attachment('roster.csv', csv(600))],
    maxInputTokens: 5144,
  },
  {
    name: 'history alternating prose and pasted csv at 8192',
    history: historyOf(24, i => (i % 2 === 0 ? prose(6, i) : csv(220, i * 220))),
    content: [attachment('roster.csv', csv(900))],
    maxInputTokens: 8192,
  },
  // (d) The control. Prose only, comfortably inside the window: the pass must not fire, or the notice
  // becomes noise the model learns to ignore.
  {
    name: 'all-prose conversation well inside the window',
    history: historyOf(4, i => prose(3, i)),
    content: [attachment('notes.txt', prose(6))],
    maxInputTokens: 16384,
    untouched: true,
  },
];

describe('final safety pass measured with the real tokenizer', () => {
  it.each(rows)('$name', async row => {
    logger.warn.mockClear();
    const prompt = row.prompt ?? [{ role: 'user' as const, content: ASK }];
    const result = await buildAndSortMessages(
      row.history,
      row.content,
      prompt,
      row.maxInputTokens,
      {},
      Math.max(row.history.length, 5),
      logger as never,
      tokenizer as never
    );

    const text = result.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');

    // The promise, in the units the caller enforces it in.
    const realTokens = await calculateTotalTokenLength(result, { estimateOnly: false, tokenizer });
    expect(realTokens).toBeLessThanOrEqual(row.maxInputTokens);

    // Not satisfiable by cutting everything: the question has to survive.
    expect(text).toContain('ASK-MARKER');

    // Declared once for the whole turn, or not at all. A per-round declaration that appends instead of
    // replacing still satisfies "the loss was declared" while spending ~100 tokens a round on duplicates
    // and counting its own stale notes as delivered files, so each copy claims one fewer loss than the
    // last. Checking that the text is present cannot see any of that; the count can.
    expect(occurrences(text, DECLARED)).toBeLessThanOrEqual(1);
    // The cut notice is per file, so several is correct here - but no single message may carry two.
    for (const message of result) {
      if (typeof message.content !== 'string') continue;
      expect(occurrences(message.content, TRUNCATED)).toBeLessThanOrEqual(1);
    }

    if (row.untouched) {
      expect(getLastBuildDebugInfo()?.wasTruncated).toBe(false);
      expect(text).not.toContain(DECLARED);
      expect(text).not.toContain(TRUNCATED);
    }
  });
});

/**
 * Untrusted text - a user message, a fab-file chunk, a fetched page - can contain a tiktoken
 * special-token literal. tiktoken's encode() rejects those by default, so both of the paths below
 * used to reject on content a user can type. Only this file can catch it: every other suite mocks
 * the tokenizer at a fixed chars/token and never reaches a real encoder.
 *
 * The literals differ per encoding, so they are not interchangeable: under cl100k_base these three
 * are special (and rejected), while e.g. `<|im_start|>` is ordinary text and proves nothing.
 */
const SPECIAL_TOKEN_LITERALS = ['<|endoftext|>', '<|endofprompt|>', '<|fim_prefix|>'];

describe('special-token literals in untrusted content', () => {
  it.each(SPECIAL_TOKEN_LITERALS)('counts a message containing %s instead of rejecting', async literal => {
    const sentence = (marker: string) => `what does ${marker} mean`;
    const messages: IMessage[] = [{ role: 'user', content: sentence(literal) }];

    const realTokens = await calculateTotalTokenLength(messages, { estimateOnly: false, tokenizer });

    // A zero here is the billing bug: ChatCompletionProcess catches the reject and leaves
    // inputTokens at 0, which under-bills backends that report no provider usage.
    expect(realTokens).toBeGreaterThan(0);
    // The literal must cost what its characters cost, not the single token it would encode to if it
    // were admitted as a real special token - that direction under-counts the turn. Same sentence
    // with a one-token marker in the literal's place, so the delta is the literal's own cost.
    const withOneToken = await calculateTotalTokenLength([{ role: 'user', content: sentence('x') }], {
      estimateOnly: false,
      tokenizer,
    });
    expect(realTokens).toBeGreaterThan(withOneToken);
  });

  it.each(SPECIAL_TOKEN_LITERALS)('assembles a prompt whose user message contains %s', async literal => {
    const result = await buildAndSortMessages(
      historyOf(4, i => prose(3, i)),
      [attachment('notes.txt', prose(6))],
      [{ role: 'user' as const, content: `${ASK} ${literal}` }],
      16384,
      {},
      5,
      logger as never,
      tokenizer as never
    );

    // buildAndSortMessages encodes the user prompt directly, and its caller does not guard the call,
    // so a reject here killed the whole completion rather than degrading a count.
    expect(result.length).toBeGreaterThan(0);
    const text = result.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(text).toContain('ASK-MARKER');
    expect(text).toContain(literal);
  });
});
