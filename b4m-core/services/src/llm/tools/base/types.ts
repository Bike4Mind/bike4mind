import { BaseStorage } from '@bike4mind/utils';
import { type ICompletionBackend, type ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { GetEffectiveApiKeyAdapters } from '../../../apiKeyService';
import {
  IChatHistoryItemDocument,
  ILatticeModel,
  IUserDocument,
  IFabFileRepository,
  IFabFileChunkRepository,
  IUserRepository,
  IProjectRepository,
  IDataLakeRepository,
  ISkillRepository,
  ImageModerationIncident,
  IUsageEventRepository,
  IOrganizationRepository,
  ModelInfo,
} from '@bike4mind/common';

/**
 * Strips comments from source code, returning the stripped text, or `null` when the
 * language is unsupported or unparsable (caller falls back to whitespace-only
 * normalization). Injected by the CLI host, which owns the web-tree-sitter dependency;
 * absent in other harnesses. Used by the opt-in `minified` mode of `file_read`.
 */
export type CodeMinifier = (source: string, ext: string) => Promise<string | null>;

export interface ToolContext {
  userId: string;
  user: IUserDocument; // Full user document for tools that need user data (e.g., blog integration)
  /**
   * Session (notebook) id of the current chat. Threaded through so file-generating tools
   * can persist their output as a session-scoped FabFile (see persistGeneratedFileAsFabFile).
   * Optional because some non-chat tool harnesses build a context without a session.
   */
  sessionId?: string;
  logger: Logger;
  db: GetEffectiveApiKeyAdapters['db'] & {
    latticeModels?: {
      create: (data: any) => Promise<ILatticeModel>;
      findById: (id: string) => Promise<ILatticeModel | null>;
      update: (data: any) => Promise<ILatticeModel | null>;
    };
    // Extended db adapters for tools that need them
    fabfiles?: IFabFileRepository;
    fabfilechunks?: Pick<IFabFileChunkRepository, 'findByFabFileId' | 'findVectorsByFabFileIds'>;
    users?: Pick<IUserRepository, 'findById'>;
    projects?: IProjectRepository;
    dataLakes?: Pick<IDataLakeRepository, 'findActiveByUserTags' | 'findActiveByUserTagsAndEntitlements'>;
    /** Optional skill repository - present when the host wires `/api/skills`. Used by the `skill` LLM tool. */
    skills?: Pick<ISkillRepository, 'findAccessibleByNameForUser' | 'listAccessibleInvocableForUser'>;
    /**
     * Audit-trail repo for blocked images. Optional - the image_generation/edit_image
     * tools construct their own RekognitionImageModerationService inline and call it regardless
     * of whether this is wired (fail-closed on the block itself); a missing repo only drops the
     * incident audit record, not the block.
     */
    imageModerationIncidents?: { record(input: ImageModerationIncident): Promise<unknown> };
    /**
     * Analytics sink for recording non-chat AI spend (e.g. KB query embeddings). Present on
     * the chat/agent paths (the full service db flows in); absent on lean tool harnesses,
     * where recording degrades to a no-op.
     */
    usageEvents?: Pick<IUsageEventRepository, 'record'>;
    /** Owner lookup for usage attribution; findById is all the recorder needs. */
    organizations?: Pick<IOrganizationRepository, 'findById'>;
  };
  /**
   * Caller's RESOLVED entitlement keys (subscription- + tag-derived), resolved app-side
   * and passed down so entitlement-gated data lakes resolve in retrieval tools. Empty/
   * absent means tag-only matching (the neutral default). See getDynamicDataLakeAccess.
   */
  entitlementKeys?: string[];
  storage: Pick<BaseStorage, 'upload' | 'getSignedUrl' | 'getPublicUrl'>;
  imageGenerateStorage: Pick<BaseStorage, 'upload' | 'getSignedUrl' | 'getPublicUrl'>;
  statusUpdate: (q: Partial<IChatHistoryItemDocument>, status?: string) => Promise<void>;
  onStart?: (toolName: string, data: any) => Promise<void>;
  onFinish?: (toolName: string, data: any) => Promise<void>;
  llm: Pick<ICompletionBackend, 'complete'>;
  model?: string; // User's selected model for the current quest
  /**
   * Model catalog for the current request, used to resolve provider + COGS pricing when a
   * tool records its own operational llm.complete spend (see recordToolOperationalUsage).
   * Present on the chat/agent path (from precomputed models); absent on lean harnesses,
   * where cost degrades to 0 but the usage event is still written.
   */
  availableModels?: ModelInfo[];
  imageProcessorLambdaName?: string; // Lambda function name for image processing (edit_image, image_generation)
  /**
   * List of allowed directories for file operations.
   * Primary working directory (cwd) is always implicitly included.
   * Additional directories can be added via --add-dir or /add-dir.
   */
  allowedDirectories?: string[];
  /** Optional code minifier for `file_read`'s opt-in `minified` mode. See CodeMinifier. */
  codeMinifier?: CodeMinifier;
}

export interface ToolDefinition {
  name: string;
  implementation: (context: Omit<ToolContext, 'config'>, config: any) => ICompletionOptionTools;
}
