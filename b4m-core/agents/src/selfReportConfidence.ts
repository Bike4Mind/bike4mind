/** A confidence assessment the model reported for its own iteration. */
export type SelfReport = {
  /** 0-1, validated; a score outside that range is never clamped into a report. */
  confidence: number;
  /** One line, whitespace-collapsed and length-capped; absent when the model gave none. */
  reason?: string;
};

const MAX_REASON_LENGTH = 200;

// Lenient on attribute quoting and tag case, strict on the value: the score is validated separately.
const TAG = /<confidence\s+score\s*=\s*["']?([^"'>\s]*)["']?\s*>([\s\S]*?)<\/confidence\s*>/gi;

/**
 * Appended to the system prompt when self-report is enabled. Asks for the tag in the same turn as the
 * next thought, so it costs no extra call.
 */
export const SELF_REPORT_CONFIDENCE_PROMPT = `CONFIDENCE REPORTING:
Begin EVERY turn that calls a tool with one line in exactly this form, before anything else. This includes each turn that follows a tool result, not only the first one:
<confidence score="0.8">one short reason</confidence>
The score is a number from 0 to 1: how confident you are that your work so far is on track and correct. Be honest; a low score pauses the run for human review, which is better than proceeding on a guess.`;

/**
 * Re-sent at the tail of every request that follows a tool result. The system-prompt instruction alone
 * is dropped by the model on later turns, so those turns fell back to the tool-based score.
 */
export const SELF_REPORT_CONFIDENCE_REMINDER =
  'Begin your next turn with the confidence line if it calls a tool: <confidence score="0.8">one short reason</confidence>';

const OPEN = '<confidence';
const CLOSE = '</confidence>';
// Models given this prompt open a turn with an empty reasoning block before the tag. It carries
// nothing, and left in it surfaces as a literal "<think></think>" thought.
const EMPTY_THINK = '<think></think>';
const EMPTY_THINK_BLOCKS = /<think>\s*<\/think>/gi;
const LEADING_FILLER = /^(?:\s|<think>\s*<\/think>)*/i;
// A tag still unclosed after this much text is not a tag; stop holding the stream back.
const MAX_HELD_LENGTH = 600;

/**
 * Keeps a leading `<confidence>` tag out of a live text stream. The prompt puts the tag first in the
 * turn (after an empty reasoning block, if the model sends one), so only that position is held back:
 * the tag is withheld until it closes and the text after it flows through. Anything else passes
 * straight through, as does a tag that never closes (`flush()` returns whatever is still held).
 * Empty reasoning blocks at the start are dropped, as `parseSelfReport` drops them from the final text.
 */
export class SelfReportStreamFilter {
  private held = '';
  private settled = false;

  /** The part of `delta` that is safe to show now. */
  push(delta: string): string {
    if (this.settled) return delta;
    this.held += delta;
    const rest = this.held.slice(LEADING_FILLER.exec(this.held)![0].length);
    const lower = rest.toLowerCase();
    if (lower === '' || OPEN.startsWith(lower) || EMPTY_THINK.startsWith(lower)) return '';
    if (!lower.startsWith(OPEN)) return this.release();
    const end = lower.indexOf(CLOSE);
    if (end === -1) return this.held.length > MAX_HELD_LENGTH ? this.release() : '';
    this.settled = true;
    this.held = '';
    return rest.slice(end + CLOSE.length).trimStart();
  }

  /** Whatever the stream ended while still holding back. */
  flush(): string {
    return this.settled ? '' : this.release();
  }

  private release(): string {
    const held = this.held.replace(EMPTY_THINK_BLOCKS, '');
    this.settled = true;
    this.held = '';
    return held;
  }
}

/**
 * Pull the model's self-reported confidence out of its turn text.
 *
 * Returns the first well-formed report and the text with every confidence tag, and every empty
 * reasoning block, removed, so neither reaches a thought or final answer. A tag whose score is
 * missing, non-numeric or outside 0-1 yields no report (the caller falls back to the tool-based
 * score) but is still stripped.
 */
export function parseSelfReport(text: string): { report?: SelfReport; text: string } {
  let report: SelfReport | undefined;
  const stripped = text.replace(TAG, (_tag, rawScore: string, rawReason: string) => {
    if (!report) {
      const confidence = rawScore.trim() === '' ? NaN : Number(rawScore);
      if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
        const reason = rawReason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
        report = reason ? { confidence, reason } : { confidence };
      }
    }
    return '';
  });
  return { report, text: stripped.replace(EMPTY_THINK_BLOCKS, '') };
}
