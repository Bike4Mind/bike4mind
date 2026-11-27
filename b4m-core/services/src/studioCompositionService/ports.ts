import type { IFabFileRepository, IProjectRepository, IStudioCompositionRepository } from '@bike4mind/common';

/** What the composition service needs from storage, injected so it is testable with in-memory fakes. */
export type StudioCompositionServiceAdapters = {
  db: {
    compositions: IStudioCompositionRepository;
    fabFiles: Pick<IFabFileRepository, 'findAccessibleInIds'>;
    projects: Pick<IProjectRepository, 'findByIdAndUserId'>;
  };
};
