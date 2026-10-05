import { LAKE_ATTACHABLE_STATUSES, type ManageableDataLakeConfig } from '@bike4mind/common';
import type { ToolDefinition } from '../../base/types';
import { listDataLakes } from '../../../../dataLakeService/listDataLakes';
import { isFallbackLake } from '../../../../dataLakeService/assertLakeAccess';
import { buildToolAccessContext } from '../../helpers/toolAccessContext';
import {
  DATA_LAKES_DISABLED_MESSAGE,
  NOT_AVAILABLE_MESSAGE,
  dataLakesEnabled,
  isAssistantWriteTarget,
  listLakesAdapters,
} from './adapters';

const TOOL_NAME = 'list_my_data_lakes';

function describeLake(lake: ManageableDataLakeConfig): string {
  const status =
    lake.status === 'draft'
      ? 'draft - not searchable until published from the Data Lakes manager'
      : 'active - searchable';
  const scope = lake.organizationId ? 'organization' : 'personal';
  return `- ${lake.name} (id: ${lake.id}) - ${status}; ${scope} lake`;
}

export const listMyDataLakesTool: ToolDefinition = {
  name: TOOL_NAME,
  implementation: context => ({
    toolFn: async () => {
      await context.onStart?.(TOOL_NAME, {});

      const adapters = listLakesAdapters(context.db);
      if (!adapters) return NOT_AVAILABLE_MESSAGE;

      try {
        if (!(await dataLakesEnabled(context.db))) return DATA_LAKES_DISABLED_MESSAGE;

        const ctx = await buildToolAccessContext(context);
        // A lake this caller can put a file into: an assistant write target (see
        // isAssistantWriteTarget), backed by a document (a built-in lake is read-only - the same
        // predicate assertLakeWritable uses), and not archived.
        const lakes = (await listDataLakes(ctx, { db: adapters })).filter(
          lake =>
            // canManage is absent only on projections that never resolved an actor; listDataLakes
            // always resolves one, so this defaults to the same "cannot manage" a resolved false means.
            isAssistantWriteTarget({ canManage: lake.canManage ?? false, isOwn: lake.isOwn }, ctx.isAdmin) &&
            !isFallbackLake(lake) &&
            (LAKE_ATTACHABLE_STATUSES as readonly string[]).includes(lake.status ?? 'active')
        );

        if (lakes.length === 0) {
          return (
            'The user has no data lake they can save to. Offer to create one with create_data_lake, ' +
            'then save into it with save_content_to_data_lake.'
          );
        }
        return (
          `Data lakes the user can save to (${lakes.length}):\n${lakes.map(describeLake).join('\n')}\n\n` +
          'Pass the chosen id as dataLakeId to save_content_to_data_lake. Ask the user which lake ' +
          'to use when more than one could fit.'
        );
      } catch (error) {
        context.logger.error('[list_my_data_lakes] failed:', error);
        return "Could not list the user's data lakes right now. Tell the user and do not guess at lake ids.";
      }
    },
    toolSchema: {
      name: TOOL_NAME,
      description:
        'List data lakes the user can save into: id, status (drafts are unsearchable), personal or org. ' +
        'Call before save_content_to_data_lake when the user has not named a lake.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  }),
};
