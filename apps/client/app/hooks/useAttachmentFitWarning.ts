import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@client/app/contexts/ApiContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import type { AttachmentFitWarning } from '@client/app/components/Session/ContextUsageWarning';

/**
 * Whether the files attached to the turn about to be sent will actually reach the model.
 *
 * The client cannot answer this alone: it knows the model's window and its own attachments, but a
 * file's TEXT length is only knowable after extraction, and `fileSize` predicts it for nothing but
 * plain text. So the figures come from /api/ai/context-dry-run, which measures server-side.
 *
 * Returns null whenever the answer is "it fits", which is the common case and must stay silent. A
 * warning that fires on a file that would have arrived whole is worse than no warning, and after the
 * budget fix a few-thousand-character file does arrive whole on an 8k model.
 */

/** Below this share reaching the model, the cut is worth interrupting the user for. */
const WARN_BELOW_FRACTION = 0.995;

/** Long enough that picking a model or dropping two files does not fire three requests. */
const DEBOUNCE_MS = 400;

export interface DryRunFile {
  id: string;
  fileName: string;
  isImage: boolean;
  extractedChars?: number;
  estimatedTokens: number;
  measured: 'extracted' | 'fileSize' | 'pending';
  deliveredFraction: number;
}

/**
 * Every file this turn will actually carry, deduped and ordered so the query key is stable.
 *
 * Pending attachments AND notebook-context files, because both spend the same per-turn extraction
 * budget. A file mid-upload or failed is excluded: there is nothing on disk to measure yet.
 */
export function collectMeasurableFileIds(
  pending: { fabFile?: { id?: string }; status?: string }[],
  notebookFileIds: string[]
): string[] {
  const ready = pending
    .filter(f => f?.fabFile?.id && f.status !== 'uploading' && f.status !== 'error')
    .map(f => String(f.fabFile!.id));
  return [...new Set([...ready, ...notebookFileIds.filter(Boolean).map(String)])].sort();
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export function useAttachmentFitWarning(
  modelId: string | null | undefined,
  /**
   * Notebook-context files. Not optional in spirit: with the default 'auto' scope every non-image
   * attachment resolves to 'notebook' (see resolveAttachScope), and pendingMessageFiles is cleared once
   * the turn is sent - so from the second turn onward the file still spends the budget and would draw
   * no warning if only the pending list were measured.
   */
  notebookFileIds: string[] = []
): AttachmentFitWarning | null {
  const { data: models } = useModelInfo();
  const pending = useSessionLayout(s => s.pendingMessageFiles ?? []);

  const fileIds = collectMeasurableFileIds(pending, notebookFileIds);

  const model = models?.find(m => m.id === modelId);
  // Keyed on the ids and the model, and debounced, so this fires on attach/remove/model-change and
  // never on a keystroke.
  const currentKey = `${modelId ?? ''}|${fileIds.join(',')}`;
  const key = useDebounced(currentKey, DEBOUNCE_MS);

  const { data } = useQuery({
    queryKey: ['contextDryRun', key],
    // A model whose dimensions we do not have would make every figure a guess, so do not ask.
    enabled: Boolean(model?.contextWindow) && fileIds.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      // The shared authed client, NOT bare axios: this route requires a bearer token, and an
      // unauthenticated call 401s, which with retry:false leaves data undefined and the banner silent -
      // indistinguishable from "the file fits".
      const res = await api.post<{ files: DryRunFile[]; textFileCount: number }>('/api/ai/context-dry-run', {
        contextWindow: model?.contextWindow,
        maxOutputTokens: model?.max_tokens,
        modelType: model?.type,
        fileIds,
      });
      return res.data;
    },
  });

  // Filtered against the CURRENT attachments, not just whatever the query last returned. Removing the
  // offending file leaves the debounced key - and react-query's cache for it - pointing at the previous
  // answer, so without this the banner outlives the file it names and the user who reacted correctly by
  // removing it is still told their file will be cut. QA measured 30+ seconds of that.
  //
  // A separate "only trust an answer computed for exactly this key" guard was tried here and removed:
  // with the filter below it can never change the outcome, and a guard no test can kill is dead code.
  return deriveAttachmentFitWarning(data?.files, data?.textFileCount, fileIds);
}

/**
 * The judgement, separated from the fetching so it can be tested directly: which file to name, and
 * whether to say anything at all.
 *
 * Returning null is the important half. The banner must stay silent on every turn whose files fit,
 * because a warning that fires on a file which would have arrived whole trains users to ignore it.
 */
export function deriveAttachmentFitWarning(
  files: DryRunFile[] | undefined,
  textFileCount: number | undefined,
  /**
   * Ids currently attached. A response can name a file that has since been removed, and warning about
   * one is the defect QA found: the banner kept naming a detached file. Omitted means "trust the
   * response", which is what a caller with no attachment state of its own can honestly say.
   */
  attachedIds?: string[]
): AttachmentFitWarning | null {
  if (!files?.length) return null;
  const stillAttached = attachedIds ? new Set(attachedIds) : null;

  // Images bypass the text budget entirely, so they can never be the reason to warn. Nor can a file
  // still awaiting moderation: the route refused to read it, so its size is unknown and warning about
  // it would be inventing a number. Both are excluded explicitly rather than left to the threshold,
  // which they happen to pass today.
  const candidates = files.filter(
    f => !f.isImage && f.measured !== 'pending' && (!stillAttached || stillAttached.has(f.id))
  );
  // The worst-fitting file is the one worth naming; listing all of them in a one-line banner would
  // bury the actionable part.
  const worst = candidates.reduce<DryRunFile | null>(
    (acc, f) => (acc === null || f.deliveredFraction < acc.deliveredFraction ? f : acc),
    null
  );

  if (!worst || worst.deliveredFraction >= WARN_BELOW_FRACTION) return null;

  return {
    fileName: worst.fileName,
    // Floored, so a file at 99.6% never reads as "100% will reach the model" next to a warning.
    deliveredPercent: Math.floor(worst.deliveredFraction * 100),
    // Narrowed by the pending exclusion above, which the compiler cannot infer.
    measured: worst.measured as 'extracted' | 'fileSize',
    siblingCount: Math.max(0, (textFileCount ?? 1) - 1),
  };
}
