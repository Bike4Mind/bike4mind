import type { IMessage } from '@bike4mind/common';

export type SystemPromptBlockSource = 'hardcoded' | 'admin' | 'user' | 'project' | 'session' | 'org';

/**
 * A named slice of the system/context block that ChatCompletionProcess assembles for a
 * completion. The assembly site builds these and flattens them into the message array, so
 * the labels and the messages actually sent stay one and the same list.
 */
export interface SystemPromptBlockSpec {
  source: SystemPromptBlockSource;
  name: string;
  messages: IMessage[];
  /**
   * Server-authored proprietary prompt content - the same class as `session.systemPromptText`
   * (see sessionRedaction). Its presence and token cost are disclosed; its text never is.
   */
  serverOwned?: boolean;
}

export interface SystemPromptBlock {
  source: SystemPromptBlockSource;
  name: string;
  tokenCount: number;
  wasIncluded: boolean;
  redacted: boolean;
  text?: string;
}

export interface SystemPromptDisclosure {
  blocks: SystemPromptBlock[];
  totalTokens: number;
  sizeCapped: boolean;
}

/**
 * Total disclosed prompt text per completion. Bounds the response payload for a session
 * carrying large project/data-lake prompts; blocks past the cap keep their metadata and
 * report `redacted`, and the disclosure sets `sizeCapped`.
 */
export const SYSTEM_PROMPT_DISCLOSURE_MAX_CHARS = 200_000;

const blockText = (messages: IMessage[]): string | undefined => {
  // Non-string content is multimodal (image parts); there is no prompt text to disclose.
  const parts = messages.map(m => m.content).filter((c): c is string => typeof c === 'string');
  return parts.length > 0 ? parts.join('\n\n') : undefined;
};

/**
 * Itemize the effective system prompt for the caller.
 *
 * `sentMessages` is the final array handed to the model. A block whose content did not
 * survive into it was assembled and then dropped (the token-budget sort, or the overflow
 * safety net), which is exactly the case a caller cannot otherwise observe.
 *
 * `withText` false yields the metadata-only form: safe to persist on the quest, which
 * serializes to the client on many read paths including shared sessions.
 */
export async function buildSystemPromptDisclosure({
  specs,
  sentMessages,
  countTokens,
  withText,
  maxTextChars = SYSTEM_PROMPT_DISCLOSURE_MAX_CHARS,
}: {
  specs: SystemPromptBlockSpec[];
  sentMessages: IMessage[];
  countTokens: (messages: IMessage[]) => Promise<number>;
  withText: boolean;
  maxTextChars?: number;
}): Promise<SystemPromptDisclosure> {
  const sentContent = new Set(sentMessages.filter(m => typeof m.content === 'string').map(m => m.content as string));

  const blocks: SystemPromptBlock[] = [];
  let charsUsed = 0;
  let sizeCapped = false;

  for (const spec of specs) {
    if (spec.messages.length === 0) continue;

    const tokenCount = await countTokens(spec.messages);
    const wasIncluded = spec.messages.every(m => typeof m.content !== 'string' || sentContent.has(m.content));

    let text: string | undefined;
    let redacted = true;
    if (withText && !spec.serverOwned) {
      const candidate = blockText(spec.messages);
      if (candidate === undefined) {
        // Multimodal-only block: nothing withheld, there is just no text to give.
        redacted = false;
      } else if (charsUsed + candidate.length <= maxTextChars) {
        text = candidate;
        charsUsed += candidate.length;
        redacted = false;
      } else {
        sizeCapped = true;
      }
    }

    blocks.push({
      source: spec.source,
      name: spec.name,
      tokenCount,
      wasIncluded,
      redacted,
      ...(text !== undefined && { text }),
    });
  }

  return {
    blocks,
    totalTokens: blocks.reduce((sum, b) => sum + b.tokenCount, 0),
    sizeCapped,
  };
}

/** Strip disclosed text, leaving the form that is safe to persist and to echo to a sharee. */
export function stripDisclosureText(disclosure: SystemPromptDisclosure): SystemPromptDisclosure {
  return {
    ...disclosure,
    blocks: disclosure.blocks.map(({ text: _text, ...block }) => ({ ...block, redacted: true })),
  };
}
