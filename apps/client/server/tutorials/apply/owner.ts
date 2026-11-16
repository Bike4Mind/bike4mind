import type { TutorialRepoLayout } from './layout';

export type OwnerVerdict = { ok: true } | { ok: false; message: string };

/** Runs before any file is read, for both bundle formats, so a bundle meant for another repo writes nothing here. */
export function checkBundleOwner(
  bundle: { owner?: string; moduleId: string },
  layout: Pick<TutorialRepoLayout, 'owner' | 'legacyOwner' | 'repoOf'>
): OwnerVerdict {
  const owner = bundle.owner ?? layout.legacyOwner;
  if (owner === layout.owner) return { ok: true };
  if (owner === undefined) {
    return {
      ok: false,
      message: `${bundle.moduleId}: this export names no owner, so it predates owners. Apply it in the repo it was exported from.`,
    };
  }
  const repo = layout.repoOf(owner) ?? `the repo that owns ${owner}`;
  return { ok: false, message: `${bundle.moduleId}: this export belongs to ${owner}; apply it in ${repo}.` };
}
