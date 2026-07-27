/**
 * How long an uploaded file stays in a notebook's context.
 *
 *  - 'notebook' -> persisted to `session.knowledgeIds`, re-sent on every later turn
 *  - 'message'  -> travels with one message as `messageFileIds`, then it is gone
 *
 * 'auto' resolves by mime type: documents stay, images do not. An image is re-encoded
 * as base64 into every turn it is attached to, so persisting one costs tokens on every
 * message forever; a document's cost is bounded by chunk retrieval. Users can still
 * override either way.
 *
 * `resolveAttachScope` has no callers yet. The upload paths still decide scope from a
 * default-off toggle, which is why an uploaded file currently drops out of context after
 * one turn; switching them over is a separate change.
 */
export type AttachScopeMode = 'auto' | 'notebook' | 'message';
export type AttachScope = 'notebook' | 'message';

/**
 * Is this mime type an image? `image/svg+xml` counts, since vision models receive it
 * as an image.
 *
 * The repo has ~50 inline `startsWith('image/')` checks and they disagree on the edges
 * (case, null handling). Only the ones on the attachment pipeline - composer upload,
 * chat context assembly, attachment capability warnings - have been converted here.
 * Icon pickers, avatar validation and resize eligibility still carry their own copies:
 * same question, unrelated subsystems, and folding them in would have made this a
 * repo-wide diff.
 */
export function isImageAttachment(mimeType?: string | null): boolean {
  return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/');
}

export function resolveAttachScope(mode: AttachScopeMode, mimeType?: string | null): AttachScope {
  if (mode !== 'auto') return mode;
  return isImageAttachment(mimeType) ? 'message' : 'notebook';
}
