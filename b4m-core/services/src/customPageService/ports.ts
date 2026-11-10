import type { ICustomPageDocument, ICustomPageRepository } from '@bike4mind/common';
import type { CreateSessionAdapters } from '../sessionService/create';

/** Repository seam for the page mutations, so the service is testable with an in-memory fake. */
export interface CustomPageServiceAdapters {
  db: {
    customPages: Pick<
      ICustomPageRepository,
      'findOwned' | 'replaceStateOwned' | 'upsertWidgetOwned' | 'removeWidgetOwned' | 'setChecklistItemOwned'
    >;
  };
}

/** createPage also opens the orchestrator session, so it needs sessionService.createSession's adapters. */
export interface CreateCustomPageAdapters extends Omit<CreateSessionAdapters, 'db'> {
  db: CreateSessionAdapters['db'] & {
    customPages: Pick<ICustomPageRepository, 'create'>;
  };
}

export type CustomPageErrorCode = 'not_found' | 'invalid' | 'state_too_large' | 'too_many_widgets' | 'conflict';

/** Mutations report expected failures as values so both the API and the LLM tools can word them. */
export type CustomPageResult =
  | { ok: true; page: ICustomPageDocument }
  | { ok: false; code: CustomPageErrorCode; message: string; issues?: string[] };

export const pageError = (code: CustomPageErrorCode, message: string, issues?: string[]): CustomPageResult => ({
  ok: false,
  code,
  message,
  ...(issues ? { issues } : {}),
});
