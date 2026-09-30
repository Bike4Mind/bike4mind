import { z } from 'zod';
import {
  FabFileSourceType,
  KnowledgeType,
  LAKE_ATTACHABLE_STATUSES,
  type IDataLakeDocument,
  type IFabFileDocument,
} from '@bike4mind/common';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { assertLakeAccessWithGrants, assertLakeWritable } from '../../../../dataLakeService/assertLakeAccess';
import { canManageLake } from '../../../../dataLakeService/manageRule';
import { addFileToDataLake } from '../../../../dataLakeService/addFileToDataLake';
import { createFabFile } from '../../../../fabFileService/create';
import { buildToolAccessContext } from '../../helpers/toolAccessContext';
import {
  DATA_LAKES_DISABLED_MESSAGE,
  NOT_AVAILABLE_MESSAGE,
  dataLakesEnabled,
  describeFailure,
  saveContentAdapters,
} from './adapters';

const TOOL_NAME = 'save_content_to_data_lake';

/** Text types the assistant can author, each with the extensions that map back to it (first wins). */
const EXTENSIONS_BY_MIME_TYPE = {
  'text/markdown': ['md', 'markdown'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'text/html': ['html', 'htm'],
  'application/json': ['json'],
} as const;

type SavableMimeType = keyof typeof EXTENSIONS_BY_MIME_TYPE;
const SAVABLE_MIME_TYPES = Object.keys(EXTENSIONS_BY_MIME_TYPE) as [SavableMimeType, ...SavableMimeType[]];
const DEFAULT_MIME_TYPE: SavableMimeType = 'text/markdown';

const SaveContentArgsSchema = z.object({
  content: z.string().min(1),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.enum(SAVABLE_MIME_TYPES).optional(),
  dataLakeId: z.string().trim().min(1),
});

const DEFAULT_BASE_NAME = 'untitled';

function mimeTypeForExtension(extension: string): SavableMimeType | undefined {
  return SAVABLE_MIME_TYPES.find(mime => (EXTENSIONS_BY_MIME_TYPE[mime] as readonly string[]).includes(extension));
}

/**
 * The stored name and type, made to agree: createFabFile resolves the type extension-first, so a
 * `notes` saved as markdown must become `notes.md` or it would be stored as plain text. With no
 * explicit type, a recognized extension decides it; otherwise markdown. A recognized extension
 * that disagrees with the type is replaced (`notes.md` as CSV -> `notes.csv`), never stacked.
 */
export function resolveFileNameAndType(
  rawFileName: string,
  requested?: SavableMimeType
): { fileName: string; mimeType: SavableMimeType } {
  const baseName = rawFileName.replace(/[\\/]/g, '-');
  const dot = baseName.lastIndexOf('.');
  const extension = dot >= 0 ? baseName.slice(dot + 1) : '';
  const extensionType = mimeTypeForExtension(extension.toLowerCase());
  const stem = (extensionType ? baseName.slice(0, dot) : baseName).trim().replace(/\.+$/, '') || DEFAULT_BASE_NAME;
  const mimeType = requested ?? extensionType ?? DEFAULT_MIME_TYPE;
  const finalExtension = extensionType === mimeType ? extension : EXTENSIONS_BY_MIME_TYPE[mimeType][0];
  return { fileName: `${stem}.${finalExtension}`, mimeType };
}

type Adapters = NonNullable<ReturnType<typeof saveContentAdapters>>;

async function createUserFile(
  context: ToolContext,
  adapters: Adapters,
  administeredOrgIds: string[] | undefined,
  file: { fileName: string; mimeType: string; content: Buffer }
): Promise<IFabFileDocument> {
  const { storage } = context;
  return createFabFile(
    context.userId,
    {
      fileName: file.fileName,
      mimeType: file.mimeType,
      fileSize: file.content.length,
      type: KnowledgeType.FILE,
      content: file.content,
      contentType: file.mimeType,
    },
    {
      db: {
        fabFiles: adapters.fabFiles,
        adminSettings: adapters.adminSettings,
        users: adapters.users,
        dataLakes: adapters.dataLakes,
        dataLakeAccessGrants: adapters.dataLakeAccessGrants,
        scopedSettings: adapters.scopedSettings,
      },
      // context.storage is the FabFile bucket - same mapping as persistGeneratedFileAsFabFile.
      storage: {
        upload: (path, content, options) => storage.upload(content, path, options),
        generateSignedUrl: (path, expireInSeconds, type) =>
          storage.getSignedUrl(path, type ?? 'get', { expiresIn: expireInSeconds }),
      },
      // A manual door: this tool only runs when the user asked for the save, so the content is the
      // user's own deliberate addition rather than something an ingest pipeline pulled in.
      provenance: { sourceType: FabFileSourceType.MANUAL_UPLOAD },
      administeredOrgIds,
      logger: context.logger,
    }
  );
}

function draftNote(lake: Pick<IDataLakeDocument, 'status'>): string {
  return lake.status === 'draft'
    ? ' The lake is still a DRAFT, so this file is not searchable until the user publishes the lake from the Data Lakes manager.'
    : '';
}

export const saveContentToDataLakeTool: ToolDefinition = {
  name: TOOL_NAME,
  implementation: context => ({
    toolFn: async (value: unknown) => {
      const parsed = SaveContentArgsSchema.safeParse(value);
      if (!parsed.success) {
        return `Invalid parameters: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      }
      const { content, dataLakeId } = parsed.data;
      const { fileName, mimeType } = resolveFileNameAndType(parsed.data.fileName, parsed.data.mimeType);
      await context.onStart?.(TOOL_NAME, { fileName, dataLakeId });

      const adapters = saveContentAdapters(context.db);
      if (!adapters) return NOT_AVAILABLE_MESSAGE;

      let lake: IDataLakeDocument;
      let ctx: Awaited<ReturnType<typeof buildToolAccessContext>>;
      try {
        if (!(await dataLakesEnabled(context.db))) return DATA_LAKES_DISABLED_MESSAGE;

        // Every gate runs BEFORE the file exists, so a target the user cannot write to never leaves
        // an orphaned file behind. addFileToDataLake re-checks all of this itself.
        ctx = await buildToolAccessContext(context);
        const resolved = await assertLakeAccessWithGrants(dataLakeId, ctx, {
          db: { dataLakes: adapters.dataLakes, dataLakeAccessGrants: adapters.dataLakeAccessGrants },
          logger: context.logger,
        });
        lake = resolved.lake;
        assertLakeWritable(lake);
        if (!canManageLake(lake, ctx, resolved.grants)) {
          return `Nothing was saved: the user cannot add files to the data lake "${lake.name}". Use list_my_data_lakes to find one they can.`;
        }
        if (lake.status && !(LAKE_ATTACHABLE_STATUSES as readonly string[]).includes(lake.status)) {
          return `Nothing was saved: the data lake "${lake.name}" is ${lake.status} and cannot take new files.`;
        }
      } catch (error) {
        context.logger.warn('[save_content_to_data_lake] target lake refused:', error);
        return `Nothing was saved: ${describeFailure(error)}. Use list_my_data_lakes to find a lake the user can save to.`;
      }

      await context.statusUpdate({}, `Saving ${fileName} to ${lake.name}...`);

      let file: IFabFileDocument;
      try {
        file = await createUserFile(context, adapters, ctx.administeredOrgIds, {
          fileName,
          mimeType,
          content: Buffer.from(content, 'utf8'),
        });
      } catch (error) {
        context.logger.error('[save_content_to_data_lake] file create failed:', error);
        return `Nothing was saved: ${describeFailure(error)}.`;
      }

      try {
        await addFileToDataLake(ctx, lake.id, file.id, {
          db: {
            dataLakes: adapters.dataLakes,
            dataLakeAccessGrants: adapters.dataLakeAccessGrants,
            fabFiles: adapters.fabFiles,
            lakeMembershipRemovals: adapters.lakeMembershipRemovals,
            adminSettings: adapters.adminSettings,
            scopedSettings: adapters.scopedSettings,
            lakeConfigChangeEvents: adapters.lakeConfigChangeEvents,
            lakeMembershipChangeEvents: adapters.lakeMembershipChangeEvents,
          },
          logger: context.logger,
        });
      } catch (error) {
        context.logger.error('[save_content_to_data_lake] add to lake failed after file create:', error);
        return (
          `Partially saved: "${fileName}" was saved to the user's files (file id: ${file.id}) but was NOT added ` +
          `to the data lake "${lake.name}": ${describeFailure(error)}. Tell the user they can add it from the ` +
          'Data Lakes manager.'
        );
      }

      return (
        `Saved "${fileName}" to the data lake "${lake.name}" (file id: ${file.id}). Indexing runs in the ` +
        `background, so it may take a few minutes before the content shows up in search.${draftNote(lake)}`
      );
    },
    toolSchema: {
      name: TOOL_NAME,
      description:
        "Save text you wrote (summary, notes, table) as a file in the user's data lake, only when asked. " +
        'Get dataLakeId from list_my_data_lakes or create_data_lake; never guess one.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The full text to save' },
          fileName: { type: 'string', description: 'e.g. "q3-summary.md"' },
          mimeType: { type: 'string', enum: SAVABLE_MIME_TYPES, description: 'Default text/markdown' },
          dataLakeId: { type: 'string', description: 'Target lake id' },
        },
        required: ['content', 'fileName', 'dataLakeId'],
      },
    },
  }),
};
