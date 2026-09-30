import { z } from 'zod';
import {
  MAX_TAG_PREFIX_LENGTH,
  MIN_DATA_LAKE_SLUG_LENGTH,
  deriveTagPrefixFromLakeName,
  slugifyDataLakeName,
  type AccessContext,
} from '@bike4mind/common';
import type { ToolDefinition } from '../../base/types';
import { createDataLake } from '../../../../dataLakeService/createDataLake';
import { buildToolAccessContext } from '../../helpers/toolAccessContext';
import {
  DATA_LAKES_DISABLED_MESSAGE,
  NOT_AVAILABLE_MESSAGE,
  createLakeAdapters,
  dataLakesEnabled,
  describeFailure,
} from './adapters';

const TOOL_NAME = 'create_data_lake';
const MAX_PREFIX_ATTEMPTS = 5;

const CreateDataLakeArgsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});

/**
 * createDataLake refuses (rather than auto-suffixes) a tag prefix that overlaps another lake or a
 * built-in one - see its assertPrefixAvailable, whose two messages this matches. The user never
 * saw a prefix here, so a disambiguated one is fine to mint on their behalf. Matched by name, not
 * `instanceof` - see httpStatusOf.
 */
function isPrefixCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'BadRequestError' &&
    /^Tag prefix ".*" (overlaps|is reserved)/.test(error.message)
  );
}

/** `acme:` -> `acme-2:`, cut so the result still fits MAX_TAG_PREFIX_LENGTH. */
export function prefixCandidate(basePrefix: string, attempt: number): string {
  if (attempt === 0) return basePrefix;
  const suffix = `-${attempt + 1}`;
  const stem = basePrefix
    .slice(0, -1)
    .slice(0, MAX_TAG_PREFIX_LENGTH - 1 - suffix.length)
    .replace(/-+$/, '');
  return `${stem}${suffix}:`;
}

/**
 * Same rule as the create wizard: the active org, else personal. The web and public paths validate
 * the org upstream (resolveActiveOrg) but Slack does not, so membership is re-checked here rather
 * than letting an unvalidated id scope the lake. Narrower than resolveActiveOrg, which also admits
 * group-shared org access, so a refusal here does not mean the user is not a member - hence the
 * wording of the refusal below.
 */
function canCreateInOrg(ctx: AccessContext, organizationId: string): boolean {
  return (
    ctx.isAdmin || ctx.organizationIds.includes(organizationId) || !!ctx.administeredOrgIds?.includes(organizationId)
  );
}

export const createDataLakeTool: ToolDefinition = {
  name: TOOL_NAME,
  implementation: context => ({
    toolFn: async (value: unknown) => {
      const parsed = CreateDataLakeArgsSchema.safeParse(value);
      if (!parsed.success) {
        return `Invalid parameters: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      }
      const { name, description } = parsed.data;
      await context.onStart?.(TOOL_NAME, { name });

      const adapters = createLakeAdapters(context.db);
      if (!adapters) return NOT_AVAILABLE_MESSAGE;

      const slug = slugifyDataLakeName(name);
      const basePrefix = deriveTagPrefixFromLakeName(name);
      if (slug.length < MIN_DATA_LAKE_SLUG_LENGTH || !basePrefix) {
        return `The lake name needs at least ${MIN_DATA_LAKE_SLUG_LENGTH} letters or digits. Ask the user for a different name.`;
      }

      try {
        if (!(await dataLakesEnabled(context.db))) return DATA_LAKES_DISABLED_MESSAGE;

        const organizationId = context.organizationId;
        if (organizationId) {
          const ctx = await buildToolAccessContext(context);
          if (!canCreateInOrg(ctx, organizationId)) {
            return (
              'The lake could not be created in the active organization from chat, so nothing was created. ' +
              'The user can create it in that organization from the Data Lakes manager, or switch to their ' +
              'personal account and ask again.'
            );
          }
        }

        await context.statusUpdate({}, `Creating data lake "${name}"...`);
        for (let attempt = 0; attempt < MAX_PREFIX_ATTEMPTS; attempt++) {
          try {
            const lake = await createDataLake(
              context.userId,
              { name, slug, description, fileTagPrefix: prefixCandidate(basePrefix, attempt) },
              { db: adapters, logger: context.logger },
              organizationId
            );
            const scope = lake.organizationId ? 'shared with the active organization' : 'personal';
            return (
              `Created data lake "${lake.name}" (id: ${lake.id}, ${scope}). It was created as a DRAFT: it is not ` +
              'searchable and not used to ground answers until the user publishes it from the Data Lakes ' +
              `manager. To save content into it, call save_content_to_data_lake with dataLakeId "${lake.id}".`
            );
          } catch (error) {
            if (!isPrefixCollision(error)) throw error;
          }
        }
        return `Could not find a free tag prefix for a lake named "${name}". Ask the user for a more distinctive name.`;
      } catch (error) {
        context.logger.error('[create_data_lake] failed:', error);
        return `The data lake was not created: ${describeFailure(error)}.`;
      }
    },
    toolSchema: {
      name: TOOL_NAME,
      description:
        'Create a data lake (personal, or in the active org). It starts as an unsearchable draft until the ' +
        'user publishes it. Only when the user wants a new lake or has none; returns its id.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lake name' },
          description: { type: 'string', description: 'Optional' },
        },
        required: ['name'],
      },
    },
  }),
};
