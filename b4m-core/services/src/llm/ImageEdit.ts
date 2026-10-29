import { getEffectiveLLMApiKeys, GetEffectiveApiKeyAdapters } from '../apiKeyService';
import {
  IChatHistoryItemDocument,
  IConnection,
  ISessionDocument,
  OpenAIImageGenerationInput,
  IUserDocument,
  LLMEventPayload,
  LLMEvents,
  BFL_SAFETY_TOLERANCE,
  IChatHistoryItemRepository,
  IUserRepository,
  PromptMeta,
  IFabFileRepository,
  EditImageRequestBodySchema,
  OpenAIImageSize,
  IAdminSettingsRepository,
  ICreditTransactionRepository,
  IUsageEventRepository,
  CreditHolderType,
  IOrganizationRepository,
  ImageModerationIncident as ImageModerationIncidentInput,
  ImageOutputFormatSchema,
  AttachmentLakeAccess,
  IFabFileDocument,
  usdToCreditsStochastic,
  type PersistedCreditHold,
} from '@bike4mind/common';
import {
  isImageServeable,
  isBflImageModel,
  isGeminiImageModel,
  rejectsTransparentBackground,
  isGPTImageModel,
  MAX_REFERENCE_IMAGES,
  supportsImageEdit,
  EDIT_SUPPORTED_IMAGE_MODELS,
  IMAGES_PER_EDIT_REQUEST,
  ImageModels,
} from '@bike4mind/common';
import {
  aiImageService,
  BadRequestError,
  ClientMessageSender,
  getSettingsMap,
  getSettingsValue,
  InternalServerError,
  isZodError,
  NotFoundError,
  OpenaiModerationsService,
  TiktokenTokenizer,
  ImageEditResponse,
  BaseStorage,
  getSettingsByNames,
  BFLImageService,
  GeminiImageService,
  OpenAIImageService,
  downloadImageAsBuffer,
} from '@bike4mind/utils';
import type { ImageModerationService } from '@bike4mind/utils/imageModeration';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { truncateImagePrompt } from './imagePromptTruncation';
import { Logger } from '@bike4mind/observability';
import { MongoAbility } from '@casl/ability';
import { fileTypeFromBuffer } from 'file-type';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';
import type { ImageCreditHolds } from './imageCreditHolds';
import { moderateImageOrThrow } from './imageModerationGate';
import { isSettledQuestStatus, startQuestHeartbeat } from './questHeartbeat';
import { estimateImageCredits } from '../imageCost';
import { getQuestErrorCode } from '@bike4mind/common';
import { recordGeneratedImages } from './recordGeneratedImages';
import { saveGeneratedImage, type SaveGeneratedAssetFn } from './saveGeneratedImage';

// Bounded wait at the mask gate for a scan still in flight: the client's on-demand call returned
// 'pending', or the S3 event owns the claim ('scanning'). Both values are in ms.
const MODERATION_WAIT_MS = 12_000;
const MODERATION_POLL_INTERVAL_MS = 750;

const isModerationInFlight = (f: { moderationStatus?: string | null }) =>
  f.moderationStatus === 'pending' || f.moderationStatus === 'scanning';

export const ImageEditBodySchema = OpenAIImageGenerationInput.extend({
  sessionId: z.string(),
  questId: z.string(),
  userId: z.string(),
  prompt: z.string(),
  organizationId: z.string().nullable().optional(),
  safety_tolerance: z
    .number()
    .min(BFL_SAFETY_TOLERANCE.MIN)
    .max(BFL_SAFETY_TOLERANCE.MAX)
    .prefault(BFL_SAFETY_TOLERANCE.DEFAULT),
  prompt_upsampling: z.boolean().prefault(false),
  seed: z.number().nullable().optional(),
  output_format: ImageOutputFormatSchema.nullable().prefault('png'),
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
  size: z.string().optional(),
  fabFileIds: z.array(z.string()).optional(),
  // Declared here as well as on EditImageRequestBodySchema: invoke() parses the queue payload
  // through this schema, and an undeclared key is stripped before it reaches process().
  referenceImageFabFileIds: z.array(z.string()).max(MAX_REFERENCE_IMAGES).optional(),
  image: z.string(),
  /** Minted per invoke(); see ImageGenerationBodySchema.generationId. */
  generationId: z.string().optional(),
  adminRoleWithheld: z.boolean().optional(),
  // `n` is inherited from OpenAIImageGenerationInput (1-10, the range generation honors) and
  // deliberately left alone: editing renders IMAGES_PER_EDIT_REQUEST whatever it says, so it is
  // accepted and ignored, never billed. Narrowing it to 1 here would 400 an API-key caller whose
  // request succeeds today.
});
export type ImageEditBody = z.infer<typeof ImageEditBodySchema>;

const IMAGE_EDIT_FEATURE_LABEL = 'image editing';

interface IImageEditServiceOptions {
  db: {
    sessions: {
      findById: (id: string) => Promise<ISessionDocument | null | undefined>;
      /** Feeds the sidebar's image marker (ISession.imageCount). Optional so test fakes compile. */
      incrementImageCount?: (sessionId: string, count: number) => Promise<void>;
    };
    quests: IChatHistoryItemRepository;
    connections: {
      findByUserId(userId: string): Promise<IConnection[]>;
      deleteByConnectionId(connectionId: string): Promise<void>;
    };
    adminSettings: IAdminSettingsRepository;
    users: IUserRepository;
    fabFiles: IFabFileRepository;
    creditTransactions?: ICreditTransactionRepository;
    usageEvents?: IUsageEventRepository;
    organizations: IOrganizationRepository;
    imageModerationIncidents?: { record(input: ImageModerationIncidentInput): Promise<unknown> };
  } & GetEffectiveApiKeyAdapters['db'];
  startImageEditProcess: (body: ImageEditBody) => Promise<void>;
  /** Reserves the estimate before the provider call. Required so the app factory cannot drop the hold. */
  creditHolds: ImageCreditHolds;
  assertModelAdmission: (user: string | IUserDocument, modelId: string, adminRoleWithheld?: boolean) => Promise<void>;
  deleteFabFile: (userId: string, fileId: string) => Promise<void>;
  wsHttpsUrl: string;
  abilityGetter: (user: IUserDocument | undefined) => MongoAbility;
  logEvent: (
    event: LLMEventPayload,
    options?: { session?: mongoose.ClientSession; ability?: MongoAbility }
  ) => Promise<void>;
  /** Storage where the generated images will be stored. */
  storage: BaseStorage;
  fabFileStorage: BaseStorage;
  /** Keeps the edited image in the user's files. Required so the app factory cannot silently drop it. */
  saveGeneratedAsset: SaveGeneratedAssetFn;
  /** Lambda function name for image processing (from SST Resource.ImageProcessor.name) */
  imageProcessorLambdaName?: string;
  /** Checks an edited image for explicit content before it's stored. Optional so existing callers/tests keep compiling; the moderation hook is a no-op when absent. */
  imageModerationService?: ImageModerationService;
  /** Mirrors ImageGenerationService: scopes fabFile lookups so a lake-only image still resolves. */
  resolveLakeAccess?: (user: IUserDocument, logger: Logger) => Promise<AttachmentLakeAccess>;
}

async function imageUrlToBase64(imageUrl: string, trustConfiguredStorageOrigin = false): Promise<string> {
  // MUST stay on `downloadImageAsBuffer`: the edit-image request body accepts `image` as a bare
  // string, so this URL is caller-controlled and a direct axios.get here is an SSRF primitive.
  // `trustConfiguredStorageOrigin` must only be set true by a caller passing a URL it just got
  // back from `getSignedUrl` - never for `imageUrl`/`sourceImageUrl`, which came from the request.
  const buffer = await downloadImageAsBuffer(imageUrl, { trustConfiguredStorageOrigin });
  return buffer.toString('base64');
}

export class ImageEditService {
  private db: IImageEditServiceOptions['db'];
  private startImageEditProcess: IImageEditServiceOptions['startImageEditProcess'];
  private creditHolds: ImageCreditHolds;
  private assertModelAdmission: IImageEditServiceOptions['assertModelAdmission'];
  private wsHttpsUrl: string;
  private logEvent: IImageEditServiceOptions['logEvent'];
  private abilityGetter: IImageEditServiceOptions['abilityGetter'];
  private storage: BaseStorage;
  private fabFileStorage: BaseStorage;
  private saveGeneratedAsset: SaveGeneratedAssetFn;
  private deleteFabFile: IImageEditServiceOptions['deleteFabFile'];
  private tokenizer: TiktokenTokenizer;
  private imageProcessorLambdaName?: string;
  private imageModerationService?: ImageModerationService;
  private resolveLakeAccess?: IImageEditServiceOptions['resolveLakeAccess'];

  constructor(options: IImageEditServiceOptions) {
    this.db = options.db;
    this.startImageEditProcess = options.startImageEditProcess;
    this.creditHolds = options.creditHolds;
    this.assertModelAdmission = options.assertModelAdmission;
    this.wsHttpsUrl = options.wsHttpsUrl;
    this.logEvent = options.logEvent;
    this.storage = options.storage;
    this.fabFileStorage = options.fabFileStorage;
    this.saveGeneratedAsset = options.saveGeneratedAsset;
    this.abilityGetter = options.abilityGetter;
    this.imageProcessorLambdaName = options.imageProcessorLambdaName;
    this.imageModerationService = options.imageModerationService;
    this.resolveLakeAccess = options.resolveLakeAccess;
    this.deleteFabFile = options.deleteFabFile;
    this.tokenizer = new TiktokenTokenizer({ logger: Logger.globalInstance });
  }

  public async invoke({
    body,
    userId,
    adminRoleWithheld,
  }: {
    adminRoleWithheld?: boolean;
    body: z.infer<typeof EditImageRequestBodySchema>;
    userId: string;
  }) {
    const now = new Date();

    const {
      sessionId,
      prompt,
      model: requestedModel,
      questId,
      fabFileIds,
      organizationId,
      ...rest
    } = EditImageRequestBodySchema.parse(body);
    if (fabFileIds.length === 0) throw new BadRequestError('No fabFileIds provided');

    // Step a gpt-image-2 selection down to gpt-image-1.5 when transparency is requested:
    // gpt-image-2 rejects background: 'transparent' outright. Resolved here, before
    // promptMeta is built, so the persisted model matches what actually renders and bills.
    const model =
      rest.background === 'transparent' && rejectsTransparentBackground(requestedModel)
        ? ImageModels.GPT_IMAGE_1_5
        : requestedModel;

    await this.assertModelAdmission(userId, model, adminRoleWithheld);
    const session = await this.db.sessions.findById(sessionId);
    if (!session) throw new NotFoundError('Session not found');

    const promptMeta: Partial<PromptMeta> = {
      model: {
        name: model,
        // Empty: the image-edit path doesn't record per-model parameters yet.
        // PromptMetaModelParametersSchema already supports image/video fields
        // (size/width/height/quality/n), so this is a "not populated here" gap, not a schema limit.
        parameters: {},
      },
      session: {
        id: sessionId,
        userId,
      },
    };

    let quest;
    if (questId) {
      quest = await this.db.quests.findById(questId);
      if (!quest) throw new NotFoundError('Quest not found');
      // Same retry-to-session binding as ChatCompletionInvoke: sessionId is access-checked at the
      // route, so a quest from another session is refused with the generic missing-quest 404.
      if (quest.sessionId !== sessionId) {
        Logger.globalInstance.warn(`Quest ${questId} does not belong to session ${sessionId}; refusing retry.`);
        throw new NotFoundError('Quest not found');
      }
      // If the quest is a retry, we need to clear out the replies and images
      quest.images = [];
      quest.replies = [];
      quest.status = undefined;
      // A failed run leaves `type: 'error'`, and the success path never resets it, so a successful
      // retry would still tell pollers and the callback to discard the render.
      quest.type = 'message';
      quest.errorCode = undefined;
      quest.promptMeta = promptMeta;
      // `undefined` alone is dropped from $set, so the prior terminal status would survive and let
      // armGenerationCallback dispatch the previous run's outcome at once, and a stale errorCode
      // would outlive a successful retry. Unset both explicitly (mirrors ChatCompletionInvoke).
      await this.db.quests.update(
        {
          id: quest.id,
          images: quest.images,
          replies: quest.replies,
          type: quest.type,
          promptMeta: quest.promptMeta,
        },
        { unset: ['status', 'errorCode'] }
      );
    } else {
      // Create the associated quest record.  We'll update this as we go.
      quest = await this.db.quests.create({
        sessionId,
        prompt,
        type: 'message',
        timestamp: now,
        replies: [],
        promptMeta,
      });
    }

    try {
      await this.startImageEditProcess(
        ImageEditBodySchema.parse({
          userId: userId,
          questId: quest.id,
          prompt,
          model,
          ...rest,
          sessionId: session.id,
          fabFileIds,
          organizationId,
          generationId: uuidv4(),
          adminRoleWithheld,
        })
      );
    } catch (error) {
      let errorMessage = `Something went wrong. Please try again.`;
      if (isZodError(error)) {
        errorMessage = fromZodError(error).message;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      quest.type = 'error';
      quest.status = 'done';
      quest.reply = errorMessage;
      // Write only the fields this error path sets, not the whole stale quest: this catch can run
      // after the success-path update above, and a whole-doc write would clobber that update.
      // `status` settles the quest like process()'s own catch does, so a poller (and an armed
      // completion callback) sees a terminal failure instead of a quest stuck in flight.
      await this.db.quests.update({ id: quest.id, type: quest.type, status: quest.status, reply: quest.reply });
    }

    return quest;
  }

  /** Prices an edit; the balance and member-cap checks happen atomically in creditHolds.hold. */
  private async estimateCredits(
    userId: string,
    model: string,
    imageParams: Pick<ImageEditBody, 'size' | 'quality'> & { inputImageCount?: number }
  ) {
    const apiKeyTable = await getEffectiveLLMApiKeys(userId, { db: this.db, getSettingsByNames });
    const models = await getAvailableModels(apiKeyTable);
    const modelInfo = models.find(m => m.id === model);
    if (!modelInfo) throw new BadRequestError(`Invalid model: "${model}" is not available`);

    // Same estimator the chat edit_image tool charges through (ToolBuilder.onToolStart), so both
    // paths bill identically. Billed for the one image this path renders, not the requested n.
    return estimateImageCredits(modelInfo, IMAGES_PER_EDIT_REQUEST, { model, ...imageParams });
  }

  /**
   * Resolves explicit gpt-image style anchors for the edit path, in the caller's order.
   *
   * Access-scoped via findAccessibleInIds, as the mask lookup in `process` now is too. A
   * reference the caller named but we cannot serve is an error rather than a silent drop
   * (where an unreachable mask is only dropped): these ids were asked for by name,
   * and quietly rendering fewer anchors bills for an image the user did not describe.
   * Mirrors ImageGenerationService.resolveReferenceImages - keep the two in step.
   */
  private async resolveReferenceImages({
    referenceImageFabFileIds,
    userId,
    userGroups,
    lakeAccess,
    model,
    logger,
  }: {
    referenceImageFabFileIds?: string[];
    userId: string;
    userGroups?: string[];
    lakeAccess?: AttachmentLakeAccess;
    model: string;
    logger: Logger;
  }): Promise<IFabFileDocument[]> {
    if (!referenceImageFabFileIds?.length) {
      return [];
    }

    if (!isGPTImageModel(model)) {
      logger.debug('Dropping reference images for a model that cannot carry them', {
        model,
        requested: referenceImageFabFileIds.length,
      });
      return [];
    }

    // A repeated id would occupy an anchor slot and pay OpenAI's per-image input cost twice
    // for bytes the model has already seen. First occurrence wins, so the caller's ordering
    // survives de-duplication. Counted after de-duplication, because the cap exists to bound
    // how many images we actually pay to send.
    const uniqueIds = [...new Set(referenceImageFabFileIds)];
    if (uniqueIds.length > MAX_REFERENCE_IMAGES) {
      throw new BadRequestError(`At most ${MAX_REFERENCE_IMAGES} reference images may be supplied`);
    }

    const files = await this.db.fabFiles.findAccessibleInIds(uniqueIds, { userId, userGroups }, lakeAccess);
    const byId = new Map(files.filter(file => !!file.id).map(file => [file.id as string, file]));

    return uniqueIds.map(id => {
      const file = byId.get(id);
      if (!file) {
        // Same distinction the mask guard in `process` makes: when lake resolution failed, a miss
        // is "we could not check", not "you may not have this". Reporting it as a 400 would blame
        // the caller for our outage and send them off verifying a share that is fine.
        if (lakeAccess?.resolutionFailed) {
          throw new InternalServerError(
            `Could not verify access to reference image ${id} because the data-lake lookup failed. Please try again.`
          );
        }
        throw new BadRequestError(`Reference image ${id} was not found or is not accessible`);
      }
      if (!file.mimeType.startsWith('image')) throw new BadRequestError(`Reference image ${id} is not an image`);
      if (!isImageServeable(file)) {
        throw new BadRequestError(`Reference image ${id} is not available (moderation pending or blocked)`);
      }
      // Without a storage path there is nothing to presign. An error rather than a skip, so a
      // half-rendered set can never reach the provider through this path either.
      if (!file.filePath) throw new BadRequestError(`Reference image ${id} has no stored file`);
      return file;
    });
  }

  /**
   * Re-reads a still-scanning file (through the same access-scoped lookup as the initial load)
   * until it leaves 'pending'/'scanning' or the budget runs out. Returns the last row seen, so the
   * caller's fail-closed gate decides: a timeout hands back a still-in-flight row, not a 'clean' one.
   * A mask that vanished or is no longer accessible returns null.
   */
  private async waitForModerationScan(
    file: IFabFileDocument,
    access: { userId: string; userGroups?: string[]; lakeAccess?: AttachmentLakeAccess }
  ): Promise<IFabFileDocument | null> {
    const deadline = Date.now() + MODERATION_WAIT_MS;
    let current = file;
    while (isModerationInFlight(current) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, MODERATION_POLL_INTERVAL_MS));
      const [refreshed] = await this.db.fabFiles.findAccessibleInIds(
        [file.id as string],
        { userId: access.userId, userGroups: access.userGroups },
        access.lakeAccess
      );
      // A mask that vanished or is no longer accessible is unavailable, not still being scanned.
      if (!refreshed) return null;
      current = refreshed;
    }
    return current;
  }

  public async process({ body, logger }: { body: z.infer<typeof ImageEditBodySchema>; logger: Logger }) {
    const {
      sessionId,
      questId,
      userId,
      adminRoleWithheld,
      prompt,
      model: requestedModel,
      safety_tolerance,
      prompt_upsampling,
      seed,
      output_format = 'jpeg',
      background,
      aspect_ratio,
      fabFileIds,
      referenceImageFabFileIds,
      size,
      quality,
      image: sourceImageUrl,
      organizationId,
      generationId,
    } = ImageEditBodySchema.parse(body);
    // Step a gpt-image-2 selection down to gpt-image-1.5 when transparency is requested:
    // gpt-image-2 rejects background: 'transparent' outright, so sending it there would
    // silently turn a valid request into an opaque image. Resolved before billing so
    // credits key off the model actually used.
    const model =
      background === 'transparent' && rejectsTransparentBackground(requestedModel)
        ? ImageModels.GPT_IMAGE_1_5
        : requestedModel;

    logger.updateMetadata({ notebookId: sessionId, questId, userId });

    const quest = await this.db.quests.findById(questId);
    if (!quest) throw new NotFoundError('Quest not found');
    // A duplicate delivery of an already-settled job must not flip it back to running.
    if (isSettledQuestStatus(quest.status)) {
      logger.warn('Image edit skipped: quest already settled', { questId, status: quest.status });
      return;
    }
    quest.status = 'running';

    const parseQuestToStreamPayload = (quest: IChatHistoryItemDocument) => {
      return {
        id: questId,
        sessionId: sessionId,
        reply: quest.reply,
        replies: quest.replies,
        type: quest.type,
        status: quest.status,
        images: quest.images,
        errorCode: quest.errorCode,
      };
    };

    const clientMessageSender = new ClientMessageSender(this.db, logger);
    const wsEndpoint = this.wsHttpsUrl;
    // Assigned inside the try, and only once every requested id resolves: the finally's mask
    // cleanup reads it, so an access-guard failure leaves the painted mask in place for the retry.
    let fabFiles: IFabFileDocument[] = [];

    // Persist status='running' + heartbeat updatedAt so a hung/killed edit is recoverable by the
    // check-timeout endpoint. Disposer is cleared in the finally below. See startQuestHeartbeat.
    let stopHeartbeat: (() => void) | undefined;
    // Cleared once settled; the finally returns a hold still set (a failure or an early return).
    let creditHold: PersistedCreditHold | undefined;

    try {
      stopHeartbeat = await startQuestHeartbeat(this.db, quest, logger, 'image-edit-heartbeat');

      // Fetch user and organization in parallel
      const [user, organization] = await Promise.all([
        this.db.users.findById(userId),
        organizationId ? this.db.organizations.findById(organizationId) : Promise.resolve(null),
      ]);
      if (!user) throw new NotFoundError('User not found');
      await this.assertModelAdmission(user, model, adminRoleWithheld);

      // skipCache: enforceCredits gates money (and ModerationEnabled below gates content safety),
      // and this host may outlive the admin's write to either.
      const settings = await getSettingsMap(this.db, { skipCache: true });
      const adminSettingsEnforceCredits = getSettingsValue('enforceCredits', settings);

      // Owner-wide lake access for scoping every fabFile lookup on this path - the mask below and
      // the anchors further down. Resolved unconditionally, mirroring ImageGenerationService: the
      // mask lookup runs on every edit, so there is no anchor-free mainline left to spare the
      // roundtrip.
      //
      // Covers PUBLISHED lakes only. The resolver behind this is active-only while the browse door
      // that admits a file to the workbench also serves draft lakes, so a file in an unpublished
      // lake is attachable and then dropped here. Pre-existing and shared with generation and the
      // chat tool, not introduced by the scoping - see findAccessibleInIds' docblock.
      //
      // A rejection is caught rather than propagated, but NOT flattened into "no lake arms": that
      // would report an outage as a clean deny. It is recorded as `resolutionFailed` and acted on
      // at the guard below, so a transient lake failure still lets an edit whose inputs all resolve
      // by ownership run normally.
      const lakeAccess = this.resolveLakeAccess
        ? await this.resolveLakeAccess(user, logger).catch(error => {
            logger.warn('[ImageEdit] Lake access resolution failed; falling back to ownership-only', {
              error: error instanceof Error ? error.message : String(error),
            });
            return { resolutionFailed: true } as AttachmentLakeAccess;
          })
        : undefined;

      // Access-scoped: a caller-supplied mask id the caller cannot reach is never presigned and
      // never fed to a provider as an alpha channel.
      const requestedFabFileIds = [...new Set(fabFileIds ?? [])];
      const accessibleFabFiles = await this.db.fabFiles.findAccessibleInIds(
        requestedFabFileIds,
        { userId, userGroups: user.groups ?? undefined },
        lakeAccess
      );

      // STRICT, like the anchor lookup below and unlike ImageGenerationService.selectInputImage:
      // an id that does not resolve fails the edit rather than being dropped.
      //
      // Dropping is not neutral here, because the mask slot is positional - `fabFiles.find(first
      // image)` further down. Losing the caller's first image silently promotes the next one, so
      // the edit runs on an input they never chose, renders a different picture, and bills for it.
      // Generation can afford leniency because its dropped candidates are guesses (carry-forward,
      // a stray attachment); every id here was put in the request by the client on the caller's
      // behalf, and a draft-lake file the workbench itself admitted is exactly the case that
      // reaches this (#3279).
      //
      // The `finally` cleanup only sees this list once the guard passes, so neither an unresolved
      // id (which deleteFabFile already refused) nor a resolved mask sent alongside it is deleted
      // on this failure - the caller retries with the same mask id after removing the bad one.
      const resolvedIds = new Set(accessibleFabFiles.map(file => file.id));
      const unresolvedIds = requestedFabFileIds.filter(id => !resolvedIds.has(id));
      if (unresolvedIds.length > 0) {
        // Separated because the remedies differ: a deny is the caller's to clear, an outage is
        // ours and is worth retrying. Flattening them would send someone off auditing a share
        // that is fine.
        if (lakeAccess?.resolutionFailed) {
          throw new InternalServerError(
            'Could not verify access to the attached files because the data-lake lookup failed. The edit was not run - please try again.'
          );
        }
        throw new BadRequestError(
          `Attached file ${unresolvedIds.join(', ')} was not found or is not accessible. Remove it from the workbench and try again.`
        );
      }
      fabFiles = accessibleFabFiles;

      const apiKeyTable = await getEffectiveLLMApiKeys(userId, { db: this.db, getSettingsByNames });

      // Editing is a narrower capability than generation, and this handler bills the
      // selected model - so reject an unsupported selection here rather than silently
      // running (and charging for) some other model. Mirrors the chat edit_image tool.
      if (!supportsImageEdit(model)) {
        throw new BadRequestError(
          `Model "${model}" does not support image editing. Supported models: ${EDIT_SUPPORTED_IMAGE_MODELS.join(', ')}`
        );
      }

      const provider = isBflImageModel(model) ? 'bfl' : isGeminiImageModel(model) ? 'gemini' : 'openai';
      const providerApiKey = apiKeyTable[provider];
      if (!providerApiKey) throw new NotFoundError(`API Key not found for ${provider}`);

      let usageCostUsd = 0;
      if (adminSettingsEnforceCredits && model && this.db.creditTransactions) {
        const { requiredCredits, usdCost } = await this.estimateCredits(userId, model, {
          size,
          quality,
          // The primary image plus the de-duped references; the mask is not an input image.
          inputImageCount: 1 + new Set(referenceImageFabFileIds ?? []).size,
        });
        // An atomic decrement, not a balance read: concurrent runs cannot all pass on one balance.
        creditHold = await this.creditHolds.hold({
          userId,
          organizationId: organization ? organization.id : null,
          requiredCredits,
          featureLabel: IMAGE_EDIT_FEATURE_LABEL,
          logger,
        });
        quest.creditsUsed = requiredCredits;
        usageCostUsd = usdCost;
      }

      // Encode the prompt to tokens
      const promptTokens = await this.tokenizer.encodeTokens(prompt, model);

      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Preparing to paint...',
      });

      if (getSettingsValue('ModerationEnabled', settings)) {
        await clientMessageSender.sendToClient(userId, wsEndpoint, {
          action: 'streamed_chat_completion',
          quest: parseQuestToStreamPayload(quest),
          statusMessage: 'Checking prompt...',
        });
        // Only moderate if using OpenAI (BFL models have their own safety_tolerance)
        if (provider !== 'bfl' && apiKeyTable.openai) {
          await new OpenaiModerationsService(apiKeyTable.openai, logger).checkPrompt(prompt);
        }
      }

      const models = await getAvailableModels(apiKeyTable);
      const {
        prompt: truncatedPrompt,
        tokenCount: sentPromptTokens,
        truncated,
      } = await truncateImagePrompt({
        prompt,
        promptTokens,
        maxTokens: models.find(m => m.id === model)?.max_tokens,
        tokenizer: this.tokenizer,
        modelId: model,
        logger,
      });

      if (truncated) {
        await clientMessageSender.sendToClient(userId, wsEndpoint, {
          action: 'streamed_chat_completion',
          quest: parseQuestToStreamPayload(quest),
          statusMessage: 'Trimming the prompt...',
        });
      }

      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Now painting...',
      });

      // Pick the first image-type fab file to send as the edit source.
      let fileImage = fabFiles.find(file => file.mimeType.startsWith('image'));

      // An explicit workbench upload used as the edit mask must not be fed into generation
      // while it's held (pending scan) or blocked. Checked once here, before the per-model
      // branches below each call `fabFileStorage.getSignedUrl` on it.
      //
      // Normally already 'clean' from the client's on-demand scan; otherwise the scan is still in
      // flight under that call ('pending') or the S3 event ('scanning'), so wait for the verdict
      // here. Still fail-closed: not 'clean' by the deadline is rejected.
      if (fileImage && isModerationInFlight(fileImage)) {
        const waited = await this.waitForModerationScan(fileImage, {
          userId,
          userGroups: user.groups ?? undefined,
          lakeAccess,
        });
        if (!waited) throw new BadRequestError('The uploaded image is not available');
        fileImage = waited;
      }
      if (fileImage && !isImageServeable(fileImage)) {
        throw new BadRequestError(
          isModerationInFlight(fileImage)
            ? 'The uploaded image is still being scanned. Please try again in a few seconds.'
            : fileImage.moderationStatus === 'blocked'
              ? 'The uploaded image is not available (blocked by moderation)'
              : 'The uploaded image is not available'
        );
      }

      let service: BFLImageService | GeminiImageService | OpenAIImageService;
      if (provider === 'bfl') {
        service = aiImageService('bfl', providerApiKey, logger, this.imageProcessorLambdaName);
      } else if (provider === 'gemini') {
        service = aiImageService('gemini', providerApiKey, logger, this.imageProcessorLambdaName);
      } else {
        service = aiImageService('openai', providerApiKey, logger, this.imageProcessorLambdaName);
      }

      const sourceBase64Image = await imageUrlToBase64(sourceImageUrl);
      if (!sourceBase64Image) throw new NotFoundError('Source image not found');

      const signedUrl = fileImage?.filePath ? await this.fabFileStorage.getSignedUrl(fileImage.filePath) : undefined;
      // `signedUrl` was just minted above from `fabFileStorage.getSignedUrl` - trusted provenance.
      const maskBase64Image = signedUrl ? await imageUrlToBase64(signedUrl, true) : undefined;

      const referenceImages = await this.resolveReferenceImages({
        referenceImageFabFileIds,
        userId,
        userGroups: user.groups ?? undefined,
        lakeAccess,
        model,
        logger,
      });
      const referenceImageUrls = await Promise.all(
        referenceImages.map(reference => this.fabFileStorage.getSignedUrl(reference.filePath as string))
      );

      Logger.globalInstance.debug(`[DEBUG] Processing ${provider} image edit:`, {
        model,
        aspect_ratio,
        hasMask: !!maskBase64Image,
        referenceImageCount: referenceImageUrls.length,
      });

      let editResponse: ImageEditResponse;
      if (provider === 'bfl') {
        // Fill is inpainting-only: without a mask there is nothing for it to fill.
        if (!maskBase64Image) throw new NotFoundError('Mask image not found');

        editResponse = await service.edit(sourceBase64Image, truncatedPrompt, {
          mask: maskBase64Image,
          model,
          safety_tolerance,
          prompt_upsampling,
          seed,
          output_format,
        });
      } else if (provider === 'gemini') {
        // Gemini edits via natural language and takes no mask; it needs a data URL.
        editResponse = await service.edit(`data:image/png;base64,${sourceBase64Image}`, truncatedPrompt, {
          model,
          aspect_ratio,
          output_format,
          safety_tolerance,
        });
      } else {
        editResponse = await service.edit(sourceBase64Image, truncatedPrompt, {
          mask: maskBase64Image || null,
          model,
          size: size as OpenAIImageSize | undefined,
          quality,
          response_format: 'url',
          user: userId,
          background,
          output_format,
          // Trail the edit source; OpenAI binds the mask to the first entry, which must stay
          // `sourceBase64Image` or an inpainting request would mask an anchor instead.
          referenceImages: referenceImageUrls,
          // `referenceImageUrls` are all freshly minted `fabFileStorage.getSignedUrl` calls above.
          trustConfiguredStorageOrigin: true,
        });
      }

      // No provider's edit path returns clarifications today.
      if (editResponse.type !== 'success') {
        throw new InternalServerError(`Unexpected response type from ${provider} image service`);
      }
      const result: string = editResponse.dataUrl;

      if (!result) throw new InternalServerError('Image edit failed');

      const userAbility = this.abilityGetter(user);

      await this.logEvent(
        // as unknown: payload lacks the event type's required metadata and sends modelId, not model; typing it would change analytics
        {
          userId,
          type: LLMEvents.QUEUE_HANDLER_IMAGE_GENERATE,
          metadata: { questId: quest.id, modelId: model },
        } as unknown as LLMEventPayload,
        { ability: userAbility }
      );

      // download images and store to s3
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Tucking your image into storage...',
      });

      Logger.globalInstance.debug('[DEBUG] Processing image for storage:', {
        imageUrl: result,
        questId,
        model,
      });

      const buffer = await downloadImageAsBuffer(result);
      const fileType = await fileTypeFromBuffer(buffer);
      const filename = `${uuidv4()}.${fileType?.ext ?? 'png'}`;

      await moderateImageOrThrow({
        service: this.imageModerationService,
        // `?? true`: fail toward moderation-ON. getSettingsValue already returns true when the
        // row is absent (default ON); the fallback guards a future refactor that could return
        // undefined - for a legal-safety control the safe last resort is enabled.
        enabled: getSettingsValue('ImageModerationEnabled', settings) ?? true,
        incidents: this.db.imageModerationIncidents,
        buffer,
        mimeType: `image/${fileType?.ext ?? 'png'}`,
        incidentMeta: {
          userId,
          sessionId: quest.sessionId,
          questId,
          provider,
          model,
          surface: 'edit',
        },
        logger,
      });

      Logger.globalInstance.debug('[DEBUG] Uploading image to storage:', {
        filename,
        fileType: fileType?.ext,
        questId,
        model,
      });

      const path = await this.storage.upload(buffer, filename, {});

      Logger.globalInstance.debug('[DEBUG] Image uploaded successfully:', {
        path,
        filename,
        questId,
        model,
      });

      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Adding to the notebook...',
      });

      Logger.globalInstance.debug('[DEBUG] Final signed URLs for images:', {
        urls: path,
        questId,
        model,
      });

      // Per-image prices are exact, so the final debit is the unbiased draw on usageCostUsd
      // (may be 0), replacing the rounded-up hold.
      const settlement = creditHold ? { credits: usdToCreditsStochastic(usageCostUsd) } : undefined;
      if (settlement) quest.creditsUsed = settlement.credits;

      quest.reply = '';
      quest.replies = [];
      quest.images = [path];
      quest.status = 'done';
      await this.db.quests.update({
        id: quest.id,
        reply: quest.reply,
        replies: quest.replies,
        images: quest.images,
        status: quest.status,
        creditsUsed: quest.creditsUsed,
      });

      await recordGeneratedImages(this.db.sessions, sessionId, 1, logger);

      // Remove prompt loading message on the client
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: null,
      });

      // Settle the hold after successful edit: keep the draw, refund the rest. A zero draw writes no ledger
      // row; the usage event still lands.
      if (settlement && creditHold) {
        // Charges never exceed the hold: any provider cost above the estimate is absorbed.
        const creditsCharged = await this.creditHolds.settle(
          creditHold,
          settlement.credits,
          { type: 'image_edit_usage', sessionId, questId, model },
          { featureLabel: IMAGE_EDIT_FEATURE_LABEL, logger }
        );
        creditHold = undefined;

        // Dual-write usage event: analytics only, never billing. Awaited because a write still in
        // flight when the Lambda handler returns can be frozen and never land; the catch keeps it
        // from failing the request.
        await this.db.usageEvents
          ?.record({
            requestId: questId,
            userId,
            ownerId: organization ? organization.id : user.id,
            ownerType: organization ? CreditHolderType.Organization : CreditHolderType.User,
            sessionId,
            feature: 'image_edit',
            provider,
            model,
            // Prompt tokens actually sent to the model, as reported by truncateImagePrompt. Image
            // models bill per-image (costUsd/units), so this is analytics-only completeness, not
            // billing.
            inputTokens: sentPromptTokens,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            units: IMAGES_PER_EDIT_REQUEST,
            costUsd: usageCostUsd,
            creditsCharged,
            status: 'ok',
          })
          .catch(err => logger.warn('Failed to record usage event', err));
      }

      // Parameters only: the source is a URL and the mask files are deleted below, so neither is recorded.
      const request = {
        model,
        prompt,
        ...(size && { size }),
        ...(quality && { quality }),
        ...(aspect_ratio && { aspect_ratio }),
        ...(seed != null && { seed }),
        safety_tolerance,
        prompt_upsampling,
        ...(output_format && { output_format }),
        ...(background && { background }),
      };
      const derivedFrom = referenceImages.flatMap(reference =>
        reference.id ? [{ fileId: reference.id, role: 'reference' as const }] : []
      );

      // Last, so a run that fails anywhere above (quest update, billing) leaves no file.
      await saveGeneratedImage(
        this.saveGeneratedAsset,
        {
          userId,
          bytes: buffer,
          contentType: fileType?.mime ?? 'image/png',
          generation: {
            generator: 'image',
            provider,
            modelId: model,
            ...(generationId && { jobId: generationId }),
            prompt,
            request,
          },
          ...(derivedFrom.length > 0 && { derivedFrom }),
          sessionId,
          questId,
        },
        logger
      );
    } catch (error) {
      Logger.globalInstance.log(error);
      quest.reply = (error as Error).message;
      quest.type = 'error';
      quest.status = 'done';
      // Tag genuine out-of-credits failures so the client renders the "Add Credits" CTA.
      quest.errorCode = getQuestErrorCode(error);
      // Targeted partial update (mirrors ImageGeneration's catch): a full-object update would
      // re-send a poisoned numeric field (e.g. a non-finite creditsUsed) and throw a CastError,
      // swallowing the error and leaving the quest stuck forever. This guarantees the error surfaces.
      await this.db.quests.update({
        id: quest.id,
        prompt: quest.prompt,
        reply: quest.reply,
        type: quest.type,
        status: quest.status,
        errorCode: quest.errorCode,
        promptMeta: quest.promptMeta,
      });
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: null,
      });
    } finally {
      // Always stop the running-status heartbeat, on success or error. The terminal write above
      // owns the final status.
      stopHeartbeat?.();
      if (creditHold) await this.creditHolds.release(creditHold, { featureLabel: IMAGE_EDIT_FEATURE_LABEL, logger });
      // Clean up the mask fab files in finally block to ensure they're always deleted.
      // Awaited, not fire-and-forget: this runs in a queue Lambda, which freezes as soon as process()
      // resolves, so a dropped delete never finishes and the mask stays in the user's files.
      Logger.globalInstance.debug('[DEBUG] Deleting mask fab files:');
      const maskFiles = fabFiles.filter(file => file.fileName.startsWith('image_mask'));
      const deletions = await Promise.allSettled(maskFiles.map(file => this.deleteFabFile(userId, file.id)));
      deletions.forEach((result, i) => {
        if (result.status === 'rejected') {
          logger.warn('[ImageEdit] Failed to delete temporary mask file', {
            fileId: maskFiles[i].id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
    }
  }
}
