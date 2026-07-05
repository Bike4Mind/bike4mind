import React, { useCallback, useState } from 'react';
import type { CommentPolicy, PublishResult, PublishVisibility } from '@bike4mind/common';
import type { ArtifactPublishOpts } from '@client/app/utils/publishApi';
import { PublishShareModal } from '@client/app/components/common/PublishShareModal';

/** A prior publication of the same artifact, surfaced so the dialog can offer
 *  "update existing vs publish as new". `resolveExisting` returns one (or null). */
export interface ExistingPublication {
  title: string;
  versionsCount?: number;
  slug: string;
  /** Current exposure of the prior publication, carried into an "update" so the default
   *  one-click re-publish can't silently widen visibility or re-enable comments. */
  visibility: PublishVisibility;
  commentPolicy?: CommentPolicy;
}

interface ShareState {
  open: boolean;
  /**
   * Performs the publish with the user-chosen visibility (and, when applicable, the
   * update-vs-new mode + slug to reuse). Null when idle.
   */
  publish: ((visibility: PublishVisibility, opts?: ArtifactPublishOpts) => Promise<PublishResult>) | null;
  title: string;
  markdown?: string;
  defaultVisibility: PublishVisibility;
  resolveExisting?: () => Promise<ExistingPublication | null>;
}

interface PublishAndShareOpts {
  /**
   * Performs the publish with the visibility the user selected in the dialog (and the
   * update-vs-new mode when a prior publication is found). NOTHING is published until the
   * user confirms in the dialog, so opening (and closing) the dialog never exposes content.
   */
  publish: (visibility: PublishVisibility, opts?: ArtifactPublishOpts) => Promise<PublishResult>;
  /** Title used for the share text + dialog. */
  title: string;
  /** Optional markdown body, enabling "Copy Markdown" in the share bar. */
  markdown?: string;
  /** Pre-selected visibility in the dialog (default 'public'). Not yet applied. */
  defaultVisibility?: PublishVisibility;
  /**
   * Optional async lookup the dialog runs on open to detect a prior publication of this
   * artifact; when it resolves to one, the dialog offers "update existing" vs "publish as
   * new". Runs only after the dialog opens, so it never publishes anything.
   */
  resolveExisting?: () => Promise<ExistingPublication | null>;
}

/**
 * Publish-and-share helper. `publishAndShare` opens a consent-first dialog: the
 * user picks visibility and confirms, and only THEN is the content published
 * (with that visibility). Returns the trigger + the dialog element. One instance
 * serves many surfaces (reply, fabfile, artifact).
 */
export function usePublishShare() {
  const [state, setState] = useState<ShareState>({
    open: false,
    publish: null,
    title: '',
    defaultVisibility: 'public',
  });

  const publishAndShare = useCallback((opts: PublishAndShareOpts) => {
    setState({
      open: true,
      publish: opts.publish,
      title: opts.title,
      markdown: opts.markdown,
      defaultVisibility: opts.defaultVisibility ?? 'public',
      resolveExisting: opts.resolveExisting,
    });
  }, []);

  const close = useCallback(() => setState(s => ({ ...s, open: false })), []);

  const modal = (
    <PublishShareModal
      open={state.open}
      onClose={close}
      publish={state.publish}
      title={state.title}
      markdown={state.markdown}
      defaultVisibility={state.defaultVisibility}
      resolveExisting={state.resolveExisting}
    />
  );

  return { publishAndShare, modal };
}
