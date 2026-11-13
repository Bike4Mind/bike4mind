// Which drafts learners may run, and the content a stored row stands for.
import type { TutorialDraftContent, TutorialRunModule, TutorialTurn } from '@bike4mind/common';
import type { ITutorialDraft } from '../models';
import type { TutorialModule } from '../types';
import type { DraftCore, DraftProfile } from './draftCore';

export type TutorialDraftRow = Omit<ITutorialDraft, 'createdAt' | 'updatedAt'> & { createdAt?: Date; updatedAt?: Date };

export function draftContentOf<TCanvas = unknown>(
  row: TutorialDraftRow,
  defaultFinale: TutorialDraftContent['finale']
): TutorialDraftContent<TCanvas> {
  return {
    moduleId: row.moduleId,
    title: row.title,
    pitch: row.pitch ?? '',
    transcript: (row.transcript ?? []) as TutorialTurn[],
    ...(row.canvas !== undefined && row.canvas !== null && { canvas: row.canvas as TCanvas }),
    ...(row.sheet && { sheet: row.sheet }),
    steps: (row.steps ?? []) as TutorialDraftContent['steps'],
    ...(row.canvasNodeId && { canvasNodeId: row.canvasNodeId }),
    finale: row.finale ?? defaultFinale,
    ...(row.visibility && { visibility: row.visibility }),
  };
}

/** Approval names the content it saw; any content save since leaves it behind. */
export const draftIsApproved = (row: Pick<TutorialDraftRow, 'approvedSeq' | 'contentSeq'>) =>
  row.approvedSeq !== undefined && row.approvedSeq !== null && row.approvedSeq === row.contentSeq;

export interface ServableDraft {
  door: TutorialRunModule;
  module: TutorialModule;
  row: TutorialDraftRow;
}

/** The draft learners may run from this row, or null: switched on, approved as it stands, valid, not shadowed. */
export function servableDraft<TCanvas extends { turn: number }>(
  core: DraftCore<TCanvas>,
  profile: Pick<DraftProfile<TCanvas>, 'isRepoModuleId' | 'defaultFinale'>,
  row: TutorialDraftRow
): ServableDraft | null {
  if (!row.enabled || !draftIsApproved(row) || profile.isRepoModuleId(row.moduleId)) return null;
  const content = draftContentOf<TCanvas>(row, profile.defaultFinale);
  if (core.validateDraft(content).length > 0) return null;
  return { ...core.draftModule(content, { revision: row.revision, enabled: true }), row };
}

/** The drafts learners may run: switched on, approved as they stand, and still passing every rule. */
export const servableDrafts = <TCanvas extends { turn: number }>(
  core: DraftCore<TCanvas>,
  profile: Pick<DraftProfile<TCanvas>, 'isRepoModuleId' | 'defaultFinale'>,
  rows: readonly TutorialDraftRow[]
): ServableDraft[] => rows.flatMap(row => servableDraft(core, profile, row) ?? []);
