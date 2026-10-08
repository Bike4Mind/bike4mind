import type { ChatRoundTiming } from '@shared/chat';

/**
 * Times one request. `firstToken` is called for every streamed event that carries anything,
 * and only the first counts: a tool-only round still has a first token, which is the point.
 */
export function startRoundTimer(now: () => number = Date.now) {
  const startedAt = now();
  let firstTokenAt: number | undefined;
  return {
    firstToken(): void {
      firstTokenAt ??= now();
    },
    end(): ChatRoundTiming {
      return { startedAt, ...(firstTokenAt !== undefined ? { firstTokenAt } : {}), endedAt: now() };
    },
  };
}

/**
 * Diagnosis only. Read once so a disabled flag costs the round loop one null check per frame.
 * See apps/desktop/docs/model-wait-findings.md for what the marks answer.
 */
export const TURN_TIMING_ENABLED = process.env.B4M_DESKTOP_TURN_TIMING === '1';

/**
 * What one stream frame carried. `marker` is a frame with text in it but nothing to show: the
 * bare `<think>` / `</think>` around a thinking block whose text the provider omitted.
 */
export type RoundFrameKind = 'meta' | 'marker' | 'reasoning' | 'text' | 'toolUse';

export interface RoundPhases {
  /** Desktop work between the turn starting and this request going out; first round only. */
  beforeSendMs?: number;
  /** From the request going out; absent when no such frame arrived. */
  firstFrameMs?: number;
  firstMetaMs?: number;
  firstMarkerMs?: number;
  firstReasoningMs?: number;
  firstTextMs?: number;
  firstToolUseMs?: number;
  endMs: number;
  /** The longest silence the status line saw, counted from the request going out. */
  maxGapMs: number;
  maxGapBefore?: RoundFrameKind | 'end';
  frames: number;
}

type FirstFrameKey = 'firstMetaMs' | 'firstMarkerMs' | 'firstReasoningMs' | 'firstTextMs' | 'firstToolUseMs';

const FIRST_KEY: Record<RoundFrameKind, FirstFrameKey> = {
  meta: 'firstMetaMs',
  marker: 'firstMarkerMs',
  reasoning: 'firstReasoningMs',
  text: 'firstTextMs',
  toolUse: 'firstToolUseMs',
};

/**
 * Splits one round's wait into phases, so a long "Waiting for the model..." can be put down to
 * our own work, a silent provider, or tool arguments that only arrive once complete.
 */
export function createRoundProbe(turnStartedAt: number | undefined, now: () => number = Date.now) {
  let sentAt = now();
  let lastFrameAt = sentAt;
  const phases: RoundPhases = { endMs: 0, maxGapMs: 0, frames: 0 };
  const gap = (at: number, kind: RoundFrameKind | 'end') => {
    if (at - lastFrameAt > phases.maxGapMs) {
      phases.maxGapMs = at - lastFrameAt;
      phases.maxGapBefore = kind;
    }
  };
  return {
    sent(): void {
      sentAt = now();
      lastFrameAt = sentAt;
      if (turnStartedAt !== undefined) phases.beforeSendMs = sentAt - turnStartedAt;
    },
    frame(kind: RoundFrameKind): void {
      const at = now();
      phases.frames++;
      phases.firstFrameMs ??= at - sentAt;
      phases[FIRST_KEY[kind]] ??= at - sentAt;
      gap(at, kind);
      lastFrameAt = at;
    },
    end(): RoundPhases {
      const at = now();
      gap(at, 'end');
      return { ...phases, endMs: at - sentAt };
    },
  };
}

/** What a sub-loop spent, summed over its rounds. Model and tool time are kept apart. */
export function createLoopTally() {
  let rounds = 0;
  let modelMs = 0;
  let toolMs = 0;
  return {
    async model<T>(run: () => Promise<T>, now: () => number = Date.now): Promise<T> {
      const started = now();
      try {
        return await run();
      } finally {
        rounds++;
        modelMs += now() - started;
      }
    },
    async tools<T>(run: () => Promise<T>, now: () => number = Date.now): Promise<T> {
      const started = now();
      try {
        return await run();
      } finally {
        toolMs += now() - started;
      }
    },
    summary: () => ({ rounds, modelMs, toolMs }),
  };
}
