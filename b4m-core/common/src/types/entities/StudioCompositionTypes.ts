import type { IMongoDocument } from './common';
import type { IStudioComposition, StudioCompositionContent } from '../../studioComposition/composition';

export type IStudioCompositionDocument = IStudioComposition & IMongoDocument;

/** A composition summary for list views: everything but the shot list and timeline, which can be large. */
export type IStudioCompositionSummary = Omit<IStudioCompositionDocument, 'shots' | 'timeline'>;

/**
 * Owner-scoped persistence for Studio compositions. Every read and write is keyed by (id, userId), so a forged
 * or guessed id for another user's composition behaves exactly like a missing one.
 */
export interface IStudioCompositionRepository {
  createOwned(composition: IStudioComposition): Promise<IStudioCompositionDocument>;
  findOwned(id: string, userId: string): Promise<IStudioCompositionDocument | null>;
  /** Newest-updated first. */
  listOwned(userId: string, page: { limit: number; skip: number }): Promise<IStudioCompositionSummary[]>;
  /** `unset` names content fields to remove, such as `projectId` to unlink a project. */
  updateOwned(
    id: string,
    userId: string,
    patch: Partial<StudioCompositionContent>,
    unset?: ReadonlyArray<keyof StudioCompositionContent>
  ): Promise<IStudioCompositionDocument | null>;
  deleteOwned(id: string, userId: string): Promise<boolean>;
}
