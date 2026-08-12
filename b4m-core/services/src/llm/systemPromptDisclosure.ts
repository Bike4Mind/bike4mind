import type { IMessage } from '@bike4mind/common';
import {
  ALWAYS_ON_FLOOR_SOURCES,
  PROMPT_SOURCE_METADATA,
  PROMPT_SOURCE_ORDER,
  type PromptSourceId,
  type TaggedSystemMessage,
} from './systemPromptSources';

/**
 * The system prompt TEXT a completion was assembled from, per source.
 *
 * Companion to `toPromptDetails`, which answers "which sources fed this completion, and at what
 * token cost". That breakdown is derived metadata and is persisted on the quest; this one is the
 * prompt itself, so it is built only when the caller asks and returned only on that caller's
 * response - never written to the quest, which serializes to every reader of a session including
 * a user it was merely shared with.
 *
 * Rows are keyed by the same `name` as the breakdown, so a caller can join the two.
 *
 * Pure: no I/O, no mutation of its inputs.
 */

/**
 * Sources whose text is withheld even from a caller who asked for it. `sessionPrompt` is
 * `session.systemPromptText`, which SERVER_OWNED_SESSION_FIELDS (see sessionRedaction) declares
 * must never reach a client: it holds proprietary server-authored prompts, and a completion
 * response is the same leak a session read would be. Presence and token cost still come back via
 * the breakdown; only the text is held back.
 */
const REDACTED_SOURCES: ReadonlySet<PromptSourceId> = new Set<PromptSourceId>(['sessionPrompt']);

/**
 * Total disclosed text per completion. Bounds the response for a session carrying large
 * project or data-lake prompts; sources past the cap keep their row and report `redacted`,
 * and the disclosure sets `sizeCapped`.
 */
export const SYSTEM_PROMPT_TEXT_MAX_CHARS = 200_000;

export interface SystemPromptTextBlock {
  /** Who authored the text, matching the breakdown row's `source`. */
  source: (typeof PROMPT_SOURCE_METADATA)[PromptSourceId]['origin'];
  /** Stable identifier, matching the breakdown row's `name`. */
  name: string;
  text?: string;
  /** True when this source contributed text that is deliberately not being returned. */
  redacted: boolean;
}

export interface SystemPromptTextDisclosure {
  blocks: SystemPromptTextBlock[];
  /** True when the character cap withheld text that would otherwise have been disclosed. */
  sizeCapped: boolean;
}

/**
 * Only system messages are emitted as-is, so only they keep the object identity the delivery
 * check relies on - the same caveat `toPromptDetails` documents at length. A user-role source
 * (an attached file, URL content) is routed through processMessages and may arrive as a fresh,
 * truncated object, so it is disclosed as assembled rather than reported undelivered.
 */
const wasDelivered = (message: IMessage, includedMessages?: ReadonlySet<IMessage>): boolean =>
  !includedMessages || message.role !== 'system' || includedMessages.has(message);

/**
 * Itemize the disclosed prompt text, one row per source that contributed.
 *
 * `includedMessages` is the set that reached the model, by reference. Passing it keeps the
 * disclosure honest about the budget dropping a block: text the model never saw is not returned
 * as though it had been.
 */
export function buildSystemPromptText(
  tagged: TaggedSystemMessage[],
  includedMessages?: ReadonlySet<IMessage>,
  maxTextChars: number = SYSTEM_PROMPT_TEXT_MAX_CHARS
): SystemPromptTextDisclosure {
  const blocks: SystemPromptTextBlock[] = [];
  let charsUsed = 0;
  let sizeCapped = false;

  for (const source of PROMPT_SOURCE_ORDER) {
    const messages = tagged.filter(t => t.source === source).map(t => t.message);
    const { origin, name } = PROMPT_SOURCE_METADATA[source];

    // One row per contributing source, matching the breakdown row-for-row so the two can be
    // joined on `name`. A source the budget dropped keeps its row with no text: the breakdown's
    // wasIncluded is what says why, and inventing a second way to say it would let them disagree.
    // The always-on floor sources keep their row even when a gate excluded them outright and they
    // contributed no message, because the breakdown inventories them unconditionally.
    if (messages.length === 0) {
      if (ALWAYS_ON_FLOOR_SOURCES.includes(source)) {
        blocks.push({ source: origin, name, redacted: false });
      }
      continue;
    }

    const delivered = messages.filter(message => wasDelivered(message, includedMessages));
    if (delivered.length === 0) {
      blocks.push({ source: origin, name, redacted: false });
      continue;
    }

    if (REDACTED_SOURCES.has(source)) {
      blocks.push({ source: origin, name, redacted: true });
      continue;
    }

    // Non-string content is multimodal (image parts); there is no prompt text to disclose, so
    // nothing is being withheld either.
    const parts = delivered.map(m => m.content).filter((c): c is string => typeof c === 'string');
    if (parts.length === 0) {
      blocks.push({ source: origin, name, redacted: false });
      continue;
    }

    const text = parts.join('\n\n');
    if (charsUsed + text.length > maxTextChars) {
      sizeCapped = true;
      blocks.push({ source: origin, name, redacted: true });
      continue;
    }

    charsUsed += text.length;
    blocks.push({ source: origin, name, text, redacted: false });
  }

  return { blocks, sizeCapped };
}
