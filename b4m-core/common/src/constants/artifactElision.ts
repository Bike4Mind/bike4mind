/**
 * User-facing copy for the suspected-elision affordances.
 *
 * Single source of truth shared across the three surfaces that report the same underlying signal:
 *  - server: `promptMeta.warnings` entry (services: ChatCompletionProcess.ts)
 *  - chat: the `artifact-elided-warning` banner (client: PromptReplies.tsx)
 *  - publish: the pre-share warning gate (client: publishApi.ts + PublishShareModal.tsx)
 *
 * These were authored independently in all three places, so a wording fix in one left the others
 * saying something subtly different about the same artifact. Keep them here.
 *
 * The wording is deliberately hedged ("look like", "may") because the detector is a heuristic and
 * the affordance is advisory - it never blocks or alters content. See
 * `@bike4mind/utils/artifactElision` for the detection contract.
 */

/** Persisted on the quest and surfaced in the debug inspector. Server-side voice. */
export const ELISION_WARNING =
  'An artifact in this response appears to have been abbreviated (placeholder comments or undefined references) and may not be fully functional.';

/** Chat banner heading. Softer than the truncation banner, which reports a certainty. */
export const ELISION_BANNER_TITLE = 'Artifact may be incomplete';

/** Chat banner body. */
export const ELISION_BANNER_BODY =
  'Parts of this artifact look like placeholders rather than working code, so some features may do nothing.';

/** Publish-gate heading. */
export const ELISION_PUBLISH_TITLE = 'This artifact may be incomplete';

/**
 * Publish-gate body. Same observation as the banner, but names the shared link, because that is the
 * point of no return: a /p/ URL can reach someone else before anyone notices the buttons are inert.
 */
export const ELISION_PUBLISH_BODY =
  'Parts of this artifact look like placeholders rather than working code, so some features may do nothing on the shared link.';
