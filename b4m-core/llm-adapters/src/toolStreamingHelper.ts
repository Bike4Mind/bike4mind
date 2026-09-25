import { filterToolArtifactMarkup, stripDeliveredArtifactBlocks, type StreamChannel } from '@bike4mind/common';
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
  /** Pass in place of the real callback on every recursive complete() call in this chain - one
   * guard instance is shared (never recreated) across every depth via `options._internal
   * .artifactGuard`, so text buffered at any level and artifacts emitted at any level stay in
   * one true generation order. */
  callback: Cb;
  /** Call in place of streaming a tool's artifact directly. Flushes whatever text is currently
   * buffered first (so an intro sentence like "here's the second chart" reaches the client
   * before the chart it introduces), records the artifact's markup as delivered, then sends it
   * straight through - never buffered, never scrubbed. */
  emitArtifact: (results: string[], info: CompletionInfo) => Promise<void>;
  /** Record artifact markup as already delivered WITHOUT sending it to the real callback or
   * touching the buffer - for a tool-execution path that delivers its own artifact through a
   * different mechanism entirely (e.g. OpenAI's Responses transport, which never streams a tool
   * artifact live and relies on server-side extraction instead). Without this, the guard would
   * have no way to recognize the model echoing that artifact's tag back in its own synthesis
   * text as an echo, since it was never told the artifact was delivered. */
  markDelivered: (markup: string) => void;
  /** Call once, only from the level that created this guard, after its own recursive
   * complete() call resolves - flushes the remaining buffered reply (with any block whose
   * identifier matches an already-delivered artifact removed) to the real callback. Always
   * emits exactly once, even when the buffered text ends up empty, so the terminal
   * token/usage/stopReason metadata that call carries (read by credit/billing attribution) is
   * never silently dropped. */
  flush: () => Promise<void>;
}

/**
 * Buffers a recursive completion's text instead of streaming it live, so an <artifact> tag the
 * model echoes back (after seeing its own tool result, even sanitized) can be stripped before the
 * client ever renders a second, empty card for it. Only removes blocks whose `identifier` matches
 * one already delivered this turn (stripDeliveredArtifactBlocks) - a stray "<artifact" the model's
 * prose merely mentions, or a genuinely NEW artifact the model composes with a different
 * identifier, must not cost the rest of a legitimate reply, unlike the tool-output-facing
 * stripToolArtifactMarkup.
 *
 * One instance is created lazily by whichever level first streams an artifact in a recursive
 * chain, and reused UNCHANGED by every deeper level (never recreated per level) - see each
 * backend's `_internal.artifactGuard`. A chained tool call's artifact goes through `emitArtifact`
 * on this same shared instance, which flushes any text already buffered ahead of it before
 * sending the artifact through - so ordering survives even when the chained call happens several
 * recursion levels below where the guard was created.
 */
export function createRecursiveArtifactGuard<Cb extends LooseCompletionCallback>(cb: Cb): RecursiveArtifactGuard<Cb> {
  let buffer = '';
  let deliveredMarkup = '';
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
  const emitArtifact = async (results: string[], info: CompletionInfo) => {
    if (buffer) {
      const pending = buffer;
      buffer = '';
      const stripped = stripDeliveredArtifactBlocks(pending, deliveredMarkup);
      if (stripped.trim()) await cb([stripped], {});
    }
    deliveredMarkup += results.join('');
    await cb(results, info);
  };
  const markDelivered = (markup: string) => {
    deliveredMarkup += markup;
  };
  const flush = async () => {
    const cleaned = stripDeliveredArtifactBlocks(buffer, deliveredMarkup).trim();
    await cb(cleaned ? [cleaned] : [], meta);
  };
  return { callback, emitArtifact, markDelivered, flush };
}
