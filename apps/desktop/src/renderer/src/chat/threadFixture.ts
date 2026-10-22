import type { ChatDiff, ChatDiffLine, ChatMessage, ChatReplyRound, ChatToolCall } from '@shared/chat';

/**
 * Synthetic conversations for measuring and pinning what opening a long thread costs. Every
 * byte is generated from a seed: nothing here is, or may ever be, copied from a real session.
 *
 * Two shapes are named because the bound is tested against both. `LARGEST_REAL_SHAPE` mirrors
 * the aggregate shape of the largest conversation measured on a working account - a handful of
 * messages carrying over a hundred tool calls, nearly all of its bytes in tool output.
 * `STRESS_SHAPE` is roughly ten times that, with everything the thread can draw in it.
 */
export interface ThreadShape {
  turns: number;
  roundsPerTurn: number;
  callsPerRound: number;
  /** Mean characters of output per tool call; individual calls vary around it. */
  previewChars: number;
  /** One call in this many is a patch carrying a diff. Zero for none. */
  diffEvery: number;
  diffLines: number;
  /** Characters of prose per round. */
  proseChars: number;
  /** One round in this many carries a fenced code block. Zero for none. */
  codeEvery: number;
  /** Message index the compaction boundary sits at; absent for none. */
  boundaryAt?: number;
  mermaid?: boolean;
}

export const LARGEST_REAL_SHAPE: ThreadShape = {
  turns: 3,
  roundsPerTurn: 25,
  callsPerRound: 2,
  previewChars: 7000,
  diffEvery: 4,
  diffLines: 26,
  proseChars: 370,
  codeEvery: 0,
};

export const STRESS_SHAPE: ThreadShape = {
  turns: 150,
  roundsPerTurn: 7,
  callsPerRound: 2,
  previewChars: 4500,
  diffEvery: 5,
  diffLines: 30,
  proseChars: 500,
  codeEvery: 3,
  boundaryAt: 100,
  mermaid: true,
};

/** mulberry32: deterministic, so a fixture is the same thread on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'the',
  'handler',
  'reads',
  'session',
  'state',
  'before',
  'writing',
  'and',
  'returns',
  'a',
  'summary',
  'of',
  'each',
  'change',
  'so',
  'that',
  'caller',
  'never',
  'sees',
  'partial',
  'result',
  'when',
  'queue',
  'drains',
  'index',
  'module',
  'test',
  'passes',
  'after',
  'patch',
  'lands',
  'build',
  'cache',
  'config',
];

const CODE_LINES = [
  'export function resolve(input: string): string {',
  '  const parts = input.split("/").filter(Boolean);',
  '  if (parts.length === 0) return ".";',
  '  return parts.map(part => part.trim()).join("/");',
  '}',
  'const cache = new Map<string, number>();',
  'for (const [key, value] of cache) console.log(key, value);',
];

function words(next: () => number, chars: number): string {
  let text = '';
  while (text.length < chars) {
    text += WORDS[Math.floor(next() * WORDS.length)];
    text += next() < 0.08 ? '.\n' : ' ';
  }
  return text.trim();
}

function code(next: () => number, lines: number): string {
  return Array.from({ length: lines }, () => CODE_LINES[Math.floor(next() * CODE_LINES.length)]).join('\n');
}

function diff(next: () => number, path: string, lines: number): ChatDiff {
  const out: ChatDiffLine[] = [];
  let oldLine = 10;
  let newLine = 10;
  let added = 0;
  let removed = 0;
  for (let i = 0; i < lines; i++) {
    const text = CODE_LINES[Math.floor(next() * CODE_LINES.length)];
    const roll = next();
    if (roll < 0.25) {
      out.push({ kind: 'add', text, newLine: newLine++ });
      added++;
    } else if (roll < 0.45) {
      out.push({ kind: 'remove', text, oldLine: oldLine++ });
      removed++;
    } else {
      out.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return { path, operation: 'edit', added, removed, lines: out };
}

/** Builds a thread of the given shape. The same shape and seed always yield the same messages. */
export function buildThread(shape: ThreadShape, seed = 1): ChatMessage[] {
  const next = random(seed);
  const messages: ChatMessage[] = [];
  const createdAt = '2026-01-01T00:00:00.000Z';
  let callSeq = 0;

  for (let turn = 0; turn < shape.turns; turn++) {
    if (shape.boundaryAt !== undefined && messages.length === shape.boundaryAt) {
      messages.push({
        id: `boundary-${turn}`,
        role: 'user',
        content: `## Summary\n\n${words(next, 600)}`,
        createdAt,
        boundary: { kind: 'compact' },
      });
    }

    messages.push({ id: `user-${turn}`, role: 'user', content: words(next, 120), createdAt });

    const toolCalls: ChatToolCall[] = [];
    const rounds: ChatReplyRound[] = [];
    for (let r = 0; r < shape.roundsPerTurn; r++) {
      const ids: string[] = [];
      for (let c = 0; c < shape.callsPerRound; c++) {
        const id = `call-${callSeq++}`;
        ids.push(id);
        const patch = shape.diffEvery > 0 && callSeq % shape.diffEvery === 0;
        const path = `/workspace/project/src/module${callSeq % 40}.ts`;
        const size = Math.round(shape.previewChars * (0.2 + next() * 1.6));
        toolCalls.push({
          id,
          name: patch ? 'apply_patch' : next() < 0.5 ? 'bash_execute' : 'file_read',
          input: patch ? { path } : { command: `grep -rn token${callSeq} src`, path },
          status: 'done',
          preview: code(next, Math.max(1, Math.round(size / 45))),
          startedAt: 1_700_000_000_000 + callSeq * 1000,
          endedAt: 1_700_000_000_000 + callSeq * 1000 + 400,
          ...(patch ? { diff: diff(next, path, shape.diffLines) } : {}),
        });
      }
      let text = words(next, shape.proseChars);
      if (shape.codeEvery > 0 && r % shape.codeEvery === 0) text += `\n\n\`\`\`ts\n${code(next, 12)}\n\`\`\`\n`;
      rounds.push({ text, toolCallIds: ids });
    }

    const last = turn === shape.turns - 1;
    messages.push({
      id: `assistant-${turn}`,
      role: 'assistant',
      content: rounds.map(round => round.text).join('\n\n'),
      createdAt,
      toolCalls,
      rounds,
      usage: { inputTokens: 1000, outputTokens: 400, creditsUsed: 12 },
      ...(last && shape.mermaid
        ? {
            artifacts: [
              {
                id: 'artifact-diagram',
                type: 'mermaid',
                title: 'Flow',
                mimeType: 'application/vnd.ant.mermaid',
                content: 'graph TD\n  A[Open] --> B[Read]\n  B --> C[Render]\n  C --> D[Paint]',
              },
            ],
          }
        : {}),
    });
  }
  return messages;
}

export function countToolCalls(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + (message.toolCalls?.length ?? 0), 0);
}
