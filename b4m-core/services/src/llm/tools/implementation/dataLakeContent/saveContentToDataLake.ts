import { z } from 'zod';
import {
  FabFileSourceType,
  KnowledgeType,
  LAKE_ATTACHABLE_STATUSES,
  type IDataLakeDocument,
  type IFabFileDocument,
} from '@bike4mind/common';
import { getMimeTypeByExtension } from '@bike4mind/utils';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { assertLakeAccessWithGrants, assertLakeWritable } from '../../../../dataLakeService/assertLakeAccess';
import { canManageLake, isEffectiveOwner } from '../../../../dataLakeService/manageRule';
import { assertLakeAdmission } from '../../../../dataLakeService/lakeAdmissionGate';
import { addFileToDataLake } from '../../../../dataLakeService/addFileToDataLake';
import { createFabFile } from '../../../../fabFileService/create';
import { buildToolAccessContext } from '../../helpers/toolAccessContext';
import {
  DATA_LAKES_DISABLED_MESSAGE,
  NOT_AVAILABLE_MESSAGE,
  dataLakesEnabled,
  describeFailure,
  isAssistantWriteTarget,
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

/** Byte cap for one save (1 MiB), far below the platform file-size limit and any single tool call's output. */
export const MAX_SAVE_CONTENT_BYTES = 1024 * 1024;
const MAX_SAVE_CONTENT_LABEL = `${MAX_SAVE_CONTENT_BYTES / (1024 * 1024)} MiB`;

/**
 * Saves one turn may make. A plain retry keeps the turn's count, so files the first attempt saved still
 * count; an edited prompt starts a fresh count (ChatCompletionInvoke's retry branch).
 */
export const MAX_LAKE_SAVES_PER_TURN = 5;

const SAVE_LIMIT_MESSAGE =
  `Nothing was saved: the limit of ${MAX_LAKE_SAVES_PER_TURN} saves per message has been reached. ` +
  'Tell the user which files were saved and ask them to send another message for the rest.';

function isSavableMimeType(mimeType: string): mimeType is SavableMimeType {
  return (SAVABLE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Our alias table first (it knows `markdown`), then storage's own map (`mdx`, `log`, `sql`, ...). */
function mimeTypeForExtension(extension: string): SavableMimeType | undefined {
  const aliased = SAVABLE_MIME_TYPES.find(mime =>
    (EXTENSIONS_BY_MIME_TYPE[mime] as readonly string[]).includes(extension)
  );
  if (aliased) return aliased;
  const storageType = extension ? getMimeTypeByExtension(extension) : '';
  return isSavableMimeType(storageType) ? storageType : undefined;
}

/**
 * The stored name and type, made to agree: createFabFile resolves the type extension-first, so a
 * `notes` saved as markdown must become `notes.md` or it would be stored as plain text. With no
 * explicit type, a recognized extension decides it; otherwise markdown. A recognized extension
 * that disagrees with the type is replaced (`notes.md` as CSV -> `notes.csv`), never stacked, and
 * one storage does not know (`notes.markdown`) is swapped for the canonical one. An extension
 * storage maps to a type this tool cannot author (`config.yaml`) stays in the stem and is stacked.
 */
export function resolveFileNameAndType(
  rawFileName: string,
  requested?: SavableMimeType
): { fileName: string; mimeType: SavableMimeType } {
  // Trailing dots (and any whitespace around them) are dropped first so `notes.md .` reads as
  // `notes.md`, not an empty or `md ` extension.
  const baseName = rawFileName.replace(/[\\/]/g, '-').replace(/[\s.]+$/, '');
  const dot = baseName.lastIndexOf('.');
  const extension = dot >= 0 ? baseName.slice(dot + 1) : '';
  const extensionType = mimeTypeForExtension(extension.toLowerCase());
  const stem = (extensionType ? baseName.slice(0, dot) : baseName).trim().replace(/\.+$/, '') || DEFAULT_BASE_NAME;
  const mimeType = requested ?? extensionType ?? DEFAULT_MIME_TYPE;
  const keepExtension = extensionType === mimeType && getMimeTypeByExtension(extension) === mimeType;
  const finalExtension = keepExtension ? extension : EXTENSIONS_BY_MIME_TYPE[mimeType][0];
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
        organizations: adapters.organizations,
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

/**
 * Claims one of the turn's saves. With a quest the count lives on it, shared by every build of this
 * tool in the turn. Without one (CLI, embed chat, deep agent, an agent run whose quest link was not
 * resolved) it falls back to a count local to this build, which restarts with each agent continuation.
 */
function makeSaveSlotClaimer(context: ToolContext): () => Promise<boolean> {
  const { questId } = context;
  const claim = context.db.quests?.claimLakeSaveSlot;
  if (questId && claim) {
    return () => claim.call(context.db.quests, questId, MAX_LAKE_SAVES_PER_TURN);
  }
  let claimed = 0;
  return async () => {
    if (claimed >= MAX_LAKE_SAVES_PER_TURN) return false;
    claimed += 1;
    return true;
  };
}

export const saveContentToDataLakeTool: ToolDefinition = {
  name: TOOL_NAME,
  implementation: context => {
    const claimSaveSlot = makeSaveSlotClaimer(context);
    return {
      toolFn: async (value: unknown) => {
        const parsed = SaveContentArgsSchema.safeParse(value);
        if (!parsed.success) {
          return `Invalid parameters: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
        }
        const { content, dataLakeId } = parsed.data;
        // Bytes, not string length: a multibyte character counts as one char but up to 4 bytes.
        const encoded = Buffer.from(content, 'utf8');
        if (encoded.length > MAX_SAVE_CONTENT_BYTES) {
          return `Nothing was saved: content is ${encoded.length} bytes, over the ${MAX_SAVE_CONTENT_LABEL} limit for one save. Split it into smaller files.`;
        }
        const { fileName, mimeType } = resolveFileNameAndType(parsed.data.fileName, parsed.data.mimeType);
        await context.onStart?.(TOOL_NAME, { fileName, dataLakeId });

        const adapters = saveContentAdapters(context.db);
        if (!adapters) return NOT_AVAILABLE_MESSAGE;

        let lake: IDataLakeDocument;
        let ctx: Awaited<ReturnType<typeof buildToolAccessContext>>;
        try {
          if (!(await dataLakesEnabled(context.db))) return DATA_LAKES_DISABLED_MESSAGE;

          // Every gate runs BEFORE the file exists, so a target the user cannot write to never leaves
          // an orphaned file behind. addFileToDataLake re-checks all of this itself, but admission only
          // after the file exists - so a server-resolved door must call it here (authorizeLakeWrite.ts).
          ctx = await buildToolAccessContext(context);
          const resolved = await assertLakeAccessWithGrants(dataLakeId, ctx, {
            db: { dataLakes: adapters.dataLakes, dataLakeAccessGrants: adapters.dataLakeAccessGrants },
            logger: context.logger,
          });
          lake = resolved.lake;
          assertLakeWritable(lake);
          const writeRights = {
            canManage: canManageLake(lake, ctx, resolved.grants),
            isOwn: isEffectiveOwner(lake, ctx, resolved.grants),
          };
          if (!isAssistantWriteTarget(writeRights, ctx.isAdmin)) {
            return `Nothing was saved: the user cannot add files to the data lake "${lake.name}". Use list_my_data_lakes to find one they can.`;
          }
          if (lake.status && !(LAKE_ATTACHABLE_STATUSES as readonly string[]).includes(lake.status)) {
            return `Nothing was saved: the data lake "${lake.name}" is ${lake.status} and cannot take new files.`;
          }
          await assertLakeAdmission([lake], [{ userId: context.userId }], {
            db: { adminSettings: adapters.adminSettings, scopedSettings: adapters.scopedSettings },
            logger: context.logger,
          });
        } catch (error) {
          context.logger.warn('[save_content_to_data_lake] target lake refused:', error);
          return `Nothing was saved: ${describeFailure(error)}. Use list_my_data_lakes to find a lake the user can save to.`;
        }

        // Claimed only once the target is accepted, so a refused lake costs no save. Not given back
        // when the create below fails: a failed attempt still counts toward the cap.
        let claimed: boolean;
        try {
          claimed = await claimSaveSlot();
        } catch (error) {
          context.logger.error('[save_content_to_data_lake] save slot claim failed:', error);
          return `Nothing was saved: ${describeFailure(error)}.`;
        }
        if (!claimed) return SAVE_LIMIT_MESSAGE;

        await context.statusUpdate({}, `Saving ${fileName} to ${lake.name}...`);

        let file: IFabFileDocument;
        try {
          file = await createUserFile(context, adapters, ctx.administeredOrgIds, {
            fileName,
            mimeType,
            content: encoded,
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
              users: adapters.users,
              organizations: adapters.organizations,
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
          `At most ${MAX_LAKE_SAVES_PER_TURN} saves per user message. ` +
          'Get dataLakeId from list_my_data_lakes or create_data_lake; never guess one.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: `The full text to save, at most ${MAX_SAVE_CONTENT_LABEL}` },
            fileName: { type: 'string', description: 'e.g. "q3-summary.md"' },
            mimeType: { type: 'string', enum: SAVABLE_MIME_TYPES, description: 'Default text/markdown' },
            dataLakeId: { type: 'string', description: 'Target lake id' },
          },
          required: ['content', 'fileName', 'dataLakeId'],
        },
      },
    };
  },
};
