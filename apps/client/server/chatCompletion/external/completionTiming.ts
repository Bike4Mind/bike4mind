import type { CompletionInfo } from '@bike4mind/common';

/**
 * Per-request phase timing for the completions route, read once at module load so a disabled
 * flag costs one null check per chunk and nothing else.
 *
 * Exists to split a long "Waiting for the model..." into its phases: our own pre-provider work,
 * the provider's silent reasoning, and tool-call arguments the stream does not carry until they
 * are complete. Marks are ms since the request reached the handler.
 */
export const COMPLETION_TIMING_ENABLED = process.env.B4M_COMPLETION_TIMING === '1';

type Phase = 'authed' | 'rateLimited' | 'completionStarted';

/** What one chunk carried, as the desktop will see it once it is an SSE frame. */
export type ChunkKind = 'reasoningMarker' | 'reasoning' | 'text' | 'toolUse' | 'usageOnly';

export interface CompletionTimingSummary {
  [mark: string]: number | string | undefined;
  maxGapMs: number;
  maxGapBefore?: ChunkKind;
  chunks: number;
}

export function classifyChunk(text: (string | null | undefined)[], info?: CompletionInfo): ChunkKind {
  if (info?.toolsUsed && info.toolsUsed.length > 0) return 'toolUse';
  const content = text[1] || text[0] || '';
  if (info?.channel === 'reasoning') {
    // The Anthropic adapter opens and closes every thinking block with a bare marker, and with
    // `display` omitted the deltas between them are empty: a frame arrives, nothing readable does.
    const readable = content.replace(/<\/?think>/g, '');
    return readable.trim() ? 'reasoning' : 'reasoningMarker';
  }
  return content ? 'text' : 'usageOnly';
}

export function createCompletionTiming(now: () => number = Date.now) {
  const receivedAt = now();
  const marks: Record<string, number> = {};
  let lastChunkAt: number | undefined;
  let maxGapMs = 0;
  let maxGapBefore: ChunkKind | undefined;
  let chunks = 0;

  const stamp = (name: string, at: number) => {
    if (marks[name] === undefined) marks[name] = at - receivedAt;
  };

  return {
    phase(name: Phase): void {
      stamp(name, now());
    },
    chunk(kind: ChunkKind): void {
      const at = now();
      chunks++;
      stamp('firstChunk', at);
      stamp(`first_${kind}`, at);
      // Gaps are measured from the completion's start, so the silence before the first chunk
      // counts as a gap too - that is the one the desktop's stall line sees first.
      const from = lastChunkAt ?? receivedAt + (marks.completionStarted ?? 0);
      if (at - from > maxGapMs) {
        maxGapMs = at - from;
        maxGapBefore = kind;
      }
      lastChunkAt = at;
    },
    summary(): CompletionTimingSummary {
      return { ...marks, endMs: now() - receivedAt, maxGapMs, maxGapBefore, chunks };
    },
  };
}

export type CompletionTiming = ReturnType<typeof createCompletionTiming>;
