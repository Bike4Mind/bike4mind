import type { KbScope, ToolContext } from './types';

/**
 * The ONE file-id scope the knowledge tools run on, collapsed from the two sources that can supply
 * one. Every tool that reads `db.fabfiles` / `db.fabfilechunks` must go through this rather than
 * reading `context.kbScope` directly - see the invariant on `ToolContext.kbScope`.
 *
 * It exists because the two sources are easy to honour inconsistently: when only one tool applied
 * the collapse, the other two stayed owner-wide and a session scoped to its own files still reached
 * every lake its owner could - through tools that are AUTO-PAIRED with the one that was fixed
 * (see addPairedTool in ChatCompletionProcess), so the gap was reachable on every such turn.
 *
 * `kbScope` wins when both are set: it is the stricter, fail-closed agent restriction, where an
 * empty list means "read NOTHING". The personal-corpus source is normalized to `undefined` when
 * empty instead, because there an empty list means "no opinion" - it must never narrow a session to
 * zero. Those opposite empty-semantics are why the two stay separate fields.
 */
export function resolveEffectiveKbScope(context: ToolContext): KbScope | undefined {
  return (
    context.kbScope ??
    (context.personalCorpusFileIds?.length ? { fileIds: context.personalCorpusFileIds } : undefined)
  );
}
