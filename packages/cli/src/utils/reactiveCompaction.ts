/**
 * Reactive compaction recovery: builds the `onContextLimit` callback
 * `ReActAgent.run()` invokes at most once when a mid-loop provider completion
 * throws a context-window error (see `AgentRunOptions.onContextLimit`).
 *
 * Delegates to the same `buildCompactionPrompt` / `createCompactedSession`
 * primitives the manual `/compact` command uses, adapted to the agent's raw
 * provider-shape `IMessage[]` working history: the most recent iterations are
 * kept verbatim (cut at a provider-safe iteration boundary via
 * `findIterationBoundary`, so a tool_use/tool_result pair is never split), and
 * everything older is flattened to plain text and summarized through
 * `agent.completeText` - a one-shot, non-reentrant call, NOT `agent.run`,
 * which would clobber the agent's own in-flight `run()` state.
 */
import { findIterationBoundary, type ReActAgent } from '@bike4mind/agents';
import type { IMessage, MessageContentObject } from '@bike4mind/common';
import type { Message, Session } from '../storage/types.js';
import { buildCompactionPrompt, createCompactedSession } from './compaction.js';

/** Most-recent iterations kept verbatim; matches /compact's default `preserveRecentExchanges`. */
const PRESERVE_RECENT_ITERATIONS = 2;

/** Render one working-history message to plain text for the summarization prompt. */
function flattenContent(content: IMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content as MessageContentObject[])
    .map(block => {
      switch (block.type) {
        case 'text':
          return block.text ?? '';
        case 'tool_use':
          return `[tool_call ${block.name}] ${JSON.stringify(block.input ?? {})}`;
        case 'tool_result':
          return `[tool_result] ${block.content ?? ''}`;
        case 'image':
        case 'image_url':
          return '[image]';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * @param session - The session this turn belongs to. Only used for
 *   `createCompactedSession`'s summary-message formatting (and workflow
 *   handoff parity); its `messages` are not read or mutated.
 * @param initialMessageCount - Length of the protected prefix (system +
 *   previousMessages + current query) passed into the matching `agent.run()`
 *   call. Must match exactly - it is the boundary below which messages are
 *   never touched, so the turn's own query is never summarized away.
 */
export function createReactiveCompactionHandler(
  agent: ReActAgent,
  session: Session,
  initialMessageCount: number
): (messages: IMessage[]) => Promise<IMessage[] | null> {
  return async messages => {
    const cutIndex = findIterationBoundary(messages, PRESERVE_RECENT_ITERATIONS, initialMessageCount);
    const toSummarize = messages.slice(initialMessageCount, cutIndex);
    if (toSummarize.length === 0) return null;

    const preservedTail = messages.slice(cutIndex);

    const asCliMessages: Message[] = toSummarize.map((m, i) => ({
      id: `reactive-compact-${i}`,
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: flattenContent(m.content),
      timestamp: new Date().toISOString(),
    }));

    const { prompt } = buildCompactionPrompt(asCliMessages, { preserveRecentExchanges: 0 });
    if (!prompt) return null;

    const summary = await agent.completeText(prompt);
    if (!summary.trim()) return null;

    // preservedMessages: [] - the recent-iteration tail is handled above as raw
    // IMessage[], not CLI Message[]; this call is only for the summary text.
    const compactedSession = createCompactedSession(session, summary, [], false);
    const summaryMessages: IMessage[] = compactedSession.messages.map(m => ({ role: 'user', content: m.content }));

    return [...messages.slice(0, initialMessageCount), ...summaryMessages, ...preservedTail];
  };
}
