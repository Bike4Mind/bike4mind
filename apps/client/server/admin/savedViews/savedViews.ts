import type { AdminSavedViewRecord, IAdminSavedViewRepository } from '@bike4mind/database';
import { BadRequestError, ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import {
  ADMIN_SAVED_VIEWS_PER_ADMIN_MAX,
  ADMIN_SAVED_VIEWS_SHARED_LIST_LIMIT,
  parseSavedView,
  type AdminSavedViewResponse,
  type AdminSavedViewSurface,
  type CreateAdminSavedViewRequestSchema,
  type UpdateAdminSavedViewRequestSchema,
} from '@client/app/utils/adminSavedViews';
import type { z } from 'zod';

export type SavedViewsLogger = { warn: (message: string, meta?: Record<string, unknown>) => void };

export type SavedViewsDeps = {
  repository: IAdminSavedViewRepository;
  logger?: SavedViewsLogger;
};

type CreateRequest = z.output<typeof CreateAdminSavedViewRequestSchema>;
type UpdateRequest = z.output<typeof UpdateAdminSavedViewRequestSchema>;

// A personal view's id must not be confirmable by another admin, so "not yours" and "no such view"
// both answer 404.
const notFound = () => new NotFoundError('Saved view not found');

const toResponse = (
  record: AdminSavedViewRecord,
  adminId: string,
  logger: SavedViewsLogger | undefined
): AdminSavedViewResponse | null => {
  const parsed = parseSavedView(record.surface, record.view);
  if (!parsed.ok) {
    logger?.warn('[admin-saved-views] skipping an unreadable saved view', {
      viewId: record.id,
      surface: record.surface,
      reason: parsed.reason,
      version: parsed.version,
    });
    return null;
  }
  return {
    id: record.id,
    surface: record.surface,
    name: record.name,
    shared: record.shared,
    ownerId: record.ownerId,
    isOwner: record.ownerId === adminId,
    view: parsed.view,
  };
};

const rethrowNameTaken = (error: unknown): never => {
  if (isDuplicateKeyError(error)) throw new ConflictError('You already have a view with that name');
  throw error;
};

/** The admin's own views on `surface` plus every other admin's shared ones, by name. */
export async function listSavedViews(
  adminId: string,
  surface: AdminSavedViewSurface,
  { repository, logger }: SavedViewsDeps
): Promise<AdminSavedViewResponse[]> {
  const records = await repository.listVisible(adminId, surface, {
    owned: ADMIN_SAVED_VIEWS_PER_ADMIN_MAX,
    shared: ADMIN_SAVED_VIEWS_SHARED_LIST_LIMIT,
  });
  return records.flatMap(record => toResponse(record, adminId, logger) ?? []);
}

export async function createSavedView(
  adminId: string,
  request: CreateRequest,
  { repository, logger }: SavedViewsDeps
): Promise<AdminSavedViewResponse> {
  const owned = await repository.countOwned(adminId, request.surface);
  if (owned >= ADMIN_SAVED_VIEWS_PER_ADMIN_MAX) {
    throw new BadRequestError(`You can save up to ${ADMIN_SAVED_VIEWS_PER_ADMIN_MAX} views here. Delete one first.`);
  }
  const record = await repository
    .create({
      ownerId: adminId,
      surface: request.surface,
      name: request.name,
      shared: request.shared,
      view: request.view,
    })
    .catch(rethrowNameTaken);
  const response = toResponse(record, adminId, logger);
  if (!response) throw new BadRequestError('The view could not be read back');
  return response;
}

/** Owner only: another admin's view, shared or not, answers 404. */
export async function updateSavedView(
  adminId: string,
  viewId: string,
  patch: UpdateRequest,
  { repository, logger }: SavedViewsDeps
): Promise<AdminSavedViewResponse> {
  let view: unknown;
  if (patch.view !== undefined) {
    // Only the users surface exists today; when another lands, read the record's surface first.
    const parsed = parseSavedView('users', patch.view);
    if (!parsed.ok) throw new BadRequestError('Not a valid saved view');
    view = parsed.view;
  }
  const record = await repository
    .updateOwned(viewId, adminId, {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.shared !== undefined && { shared: patch.shared }),
      ...(view !== undefined && { view }),
    })
    .catch(rethrowNameTaken);
  if (!record) throw notFound();
  const response = toResponse(record, adminId, logger);
  if (!response) throw new BadRequestError('The view could not be read back');
  return response;
}

export async function deleteSavedView(adminId: string, viewId: string, { repository }: SavedViewsDeps): Promise<void> {
  if (!(await repository.deleteOwned(viewId, adminId))) throw notFound();
}
