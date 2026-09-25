import { filterToolArtifactMarkup, stripCompleteArtifactBlocks, type StreamChannel } from '@bike4mind/common';
import type { CompletionInfo } from './backend';

/**
 * Helper function to handle tool result streaming for artifact-generating tools
 * This ensures tools like recharts that generate artifacts are streamed immediately
 * rather than waiting for recursive completion calls.
 *
 * Only the emitters in TOOL_ARTIFACT_EMITTERS stream, and only their pinned artifact type:
 * streamed text is parsed into reply artifacts, so any other tool's markup would render.
 *
 * What does stream is still a raw tool artifact rather than reply prose, so `streamCallback`
 * receives the channel tag and a public surface drops the text on that tag alone.
 */
export async function handleToolResultStreaming(
  toolName: string,
  toolResult: unknown,
  streamCallback: (results: string[], info: { channel: StreamChannel }) => Promise<void>
): Promise<void> {
  const filtered = filterToolArtifactMarkup(toolName, String(toolResult));

  if (filtered !== null) {
    await streamCallback([filtered], { channel: 'tool-artifact' });
  }
}

// The four backends' own completion-callback types differ only in whether `info` is required
// (Anthropic, Gemini) or optional (Bedrock) - structurally incompatible with each other in both
// directions under this repo's strict function-type checking, so `info` is typed `any` here to
// accept every one of them. `Cb` is inferred from whatever's actually passed in, so the returned
// `callback` always satisfies that exact same backend's own `complete()` signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
type LooseCompletionCallback = (text: (string | null | undefined)[], info: any) => Promise<void>;

export interface RecursiveArtifactGuard<Cb extends LooseCompletionCallback> {
  /** Pass in place of the real callback on the recursive complete() call that follows a round
   * where an artifact was already streamed. */
  callback: Cb;
  /** Call once after that recursive complete() resolves - flushes the buffered reply (with any
   * echoed artifact markup removed) to the real callback. Always emits exactly once, even when
   * the buffered text ends up empty, so the terminal token/usage/stopReason metadata that call
   * carries (read by credit/billing attribution) is never silently dropped. */
  flush: () => Promise<void>;
}

/**
 * Buffers a recursive completion's text instead of streaming it live, so an <artifact> tag the
 * model echoes back (after seeing its own tool result, even sanitized) can be stripped before the
 * client ever renders a second, empty card for it. Only removes COMPLETE, well-formed blocks
 * (stripCompleteArtifactBlocks) - a stray "<artifact" the model's prose merely mentions must not
 * cost the rest of a legitimate reply, unlike the tool-output-facing stripToolArtifactMarkup.
 *
 * This guard only ever sees model-authored text: a genuinely new artifact from a CHAINED tool call
 * within this same recursive turn must bypass it entirely (streamed straight to the real callback),
 * or the guard would delete that legitimate card too - see each backend's `artifactCallback`
 * threaded through `options._internal`, which every `handleToolResultStreaming` call uses instead
 * of the (possibly-buffering) local callback.
 */
export function createRecursiveArtifactGuard<Cb extends LooseCompletionCallback>(cb: Cb): RecursiveArtifactGuard<Cb> {
  let buffer = '';
  let meta: CompletionInfo = {};
  const callback = (async (text: (string | null | undefined)[], info: CompletionInfo | undefined) => {
    for (const chunk of text) {
      if (chunk != null) buffer += chunk;
    }
    // Last write wins: the terminal call in the chain is always the last one to fire, and it
    // carries the complete accumulated totals - an earlier partial call must never overwrite it.
    // Gated on actual token presence (not just truthy info) so a call carrying no tokens (e.g. a
    // bare { toolsUsed: [] }) can never clobber a previously-captured terminal total.
    if (info?.inputTokens || info?.outputTokens) meta = { ...info };
  }) as Cb;
  const flush = async () => {
    const cleaned = stripCompleteArtifactBlocks(buffer).trim();
    await cb(cleaned ? [cleaned] : [], meta);
  };
  return { callback, flush };
}
