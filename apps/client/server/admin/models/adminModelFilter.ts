import { AdminModelFilterSchema, type AdminModelFilter } from '@bike4mind/common';
import { modelDiscoveryService } from '@bike4mind/services';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { loadAdminModelRows } from './adminModelList';

/**
 * The model ids a `{ filter }` selection covers: exactly what GET /api/admin/models lists for that filter across all
 * its pages, sorted by id. Profile-only Bedrock foundation ids stay out unless the filter sets showFoundationIds.
 * Throws BadRequestError (400) on a filter that does not parse.
 */
export async function resolveAdminModelFilterIds(filter: AdminModelFilter): Promise<string[]> {
  const parsed = AdminModelFilterSchema.safeParse(filter);
  if (!parsed.success) {
    throw new BadRequestError(`invalid model filter: ${parsed.error.issues[0]?.message ?? 'unreadable'}`);
  }
  return modelDiscoveryService.filterAdminModels(await loadAdminModelRows(), parsed.data).map(row => row.id);
}
