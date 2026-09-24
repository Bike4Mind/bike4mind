import { getEffectiveLLMApiKeys, GetEffectiveApiKeyAdapters } from '../apiKeyService';
import {
  IChatHistoryItemDocument,
  IConnection,
  ISessionDocument,
  OpenAIImageGenerationInput,
  IUserDocument,
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
  IOrganizationDocument,
  ImageModerationIncident as ImageModerationIncidentInput,
  insufficientCreditsError,
  ImageOutputFormatSchema,
  AttachmentLakeAccess,
  IFabFileDocument,
} from '@bike4mind/common';
import {
  isImageServeable,
  isBflImageModel,
  isGeminiImageModel,
  isGPTImage2Model,
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
import { deductCreditsWithOrgSupport, isMemberCreditCapExceeded } from '../creditService';
import { moderateImageOrThrow } from './imageModerationGate';
import { startQuestHeartbeat } from './questHeartbeat';
// Aliased: this module also has a private method named validateUserCredits.
import { validateUserCredits as validateImageUserCredits } from './tools/base/utils';
import { getQuestErrorCode } from '@bike4mind/common';

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
    .optional()
    .prefault(BFL_SAFETY_TOLERANCE.DEFAULT),
  prompt_upsampling: z.boolean().optional().prefault(false),
  seed: z.number().nullable().optional(),
  output_format: ImageOutputFormatSchema.nullable().optional().prefault('png'),
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
  size: z.string().optional(),
  fabFileIds: z.array(z.string()).optional(),
  // Declared here as well as on EditImageRequestBodySchema: invoke() parses the queue payload
  // through this schema, and an undeclared key is stripped before it reaches process().
  referenceImageFabFileIds: z.array(z.string()).max(MAX_REFERENCE_IMAGES).optional(),
  image: z.string(),
  // `n` is inherited from OpenAIImageGenerationInput (1-10, the range generation honors) and
  // deliberately left alone: editing renders IMAGES_PER_EDIT_REQUEST whatever it says, so it is
  // accepted and ignored, never billed. Narrowing it to 1 here would 400 an API-key caller whose
  // request succeeds today.
});
export type ImageEditBody = z.infer<typeof ImageEditBodySchema>;

interface IImageEditServiceOptions {
  db: {
    sessions: {
      findById: (id: string) => Promise<ISessionDocument | null | undefined>;
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
  deleteFabFile: (userId: string, fileId: string) => Promise<void>;
  wsHttpsUrl: string;
  abilityGetter: (user: IUserDocument | undefined) => MongoAbility;
  logEvent: (event: any, options?: { session?: mongoose.ClientSession; ability?: MongoAbility }) => Promise<any>;
  /** Storage where the generated images will be stored. */
  storage: BaseStorage;
  fabFileStorage: BaseStorage;
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
  private wsHttpsUrl: string;
  private logEvent: IImageEditServiceOptions['logEvent'];
  private abilityGetter: IImageEditServiceOptions['abilityGetter'];
  private storage: BaseStorage;
  private fabFileStorage: BaseStorage;
  private deleteFabFile: IImageEditServiceOptions['deleteFabFile'];
  private tokenizer: TiktokenTokenizer;
  private imageProcessorLambdaName?: string;
  private imageModerationService?: ImageModerationService;
  private resolveLakeAccess?: IImageEditServiceOptions['resolveLakeAccess'];

  constructor(options: IImageEditServiceOptions) {
    this.db = options.db;
    this.startImageEditProcess = options.startImageEditProcess;
    this.wsHttpsUrl = options.wsHttpsUrl;
    this.logEvent = options.logEvent;
    this.storage = options.storage;
    this.fabFileStorage = options.fabFileStorage;
    this.abilityGetter = options.abilityGetter;
    this.imageProcessorLambdaName = options.imageProcessorLambdaName;
    this.imageModerationService = options.imageModerationService;
    this.resolveLakeAccess = options.resolveLakeAccess;
    this.deleteFabFile = options.deleteFabFile;
    this.tokenizer = new TiktokenTokenizer({ logger: Logger.globalInstance });
  }

  public async invoke({ body, userId }: { body: z.infer<typeof EditImageRequestBodySchema>; userId: string }) {
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
      rest.background === 'transparent' && isGPTImage2Model(requestedModel)
        ? ImageModels.GPT_IMAGE_1_5
        : requestedModel;

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
      // If the quest is a retry, we need to clear out the replies and images
      quest.images = [];
      quest.replies = [];
      quest.status = undefined;
      quest.promptMeta = promptMeta;
      await this.db.quests.update(quest);
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
      quest.reply = errorMessage;
      // Write only the fields this error path sets, not the whole stale quest: this catch can run
      // after the success-path update above, and a whole-doc write would clobber that update.
      await this.db.quests.update({ id: quest.id, type: quest.type, reply: quest.reply });
    }

    return quest;
  }

  private async validateUserCredits(
    user: IUserDocument,
    model: string,
    imageParams: Pick<ImageEditBody, 'size' | 'quality'>,
    logger: Logger,
    organization?: IOrganizationDocument | null
  ) {
    const apiKeyTable = await getEffectiveLLMApiKeys(user.id, { db: this.db, getSettingsByNames });
    const models = await getAvailableModels(apiKeyTable);
    const modelInfo = models.find(m => m.id === model);
    if (!modelInfo) throw new BadRequestError(`Invalid model: "${model}" is not available`);

    // Same estimator the chat edit_image tool charges through (ToolBuilder.onToolStart), so both
    // paths bill identically. Billed for the one image this path renders, not the requested n.
    const result = await validateImageUserCredits(
      user,
      modelInfo,
      IMAGES_PER_EDIT_REQUEST,
      { model, ...imageParams },
      logger,
      organization
    );

    // Org-billed: enforce the per-member cap here, at pre-flight, before touching the
    // shared pool. This is the only enforcement point - the settlement write
    // (deductCreditsWithOrgSupport) intentionally does NOT re-check the cap (#1536).
    if (organization && isMemberCreditCapExceeded(organization, user.id, result.requiredCredits)) {
      throw insufficientCreditsError(
        `Your organization member credit limit has been reached for image editing. Contact your organization administrator.`
      );
    }

    return result;
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

  public async process({ body, logger }: { body: z.infer<typeof ImageEditBodySchema>; logger: Logger }) {
    const {
      sessionId,
      questId,
      userId,
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
    } = ImageEditBodySchema.parse(body);
    // Step a gpt-image-2 selection down to gpt-image-1.5 when transparency is requested:
    // gpt-image-2 rejects background: 'transparent' outright, so sending it there would
    // silently turn a valid request into an opaque image. Resolved before billing so
    // credits key off the model actually used.
    const model =
      background === 'transparent' && isGPTImage2Model(requestedModel) ? ImageModels.GPT_IMAGE_1_5 : requestedModel;

    logger.updateMetadata({ notebookId: sessionId, questId, userId });

    const quest = await this.db.quests.findById(questId);
    if (!quest) throw new NotFoundError('Quest not found');
    quest.status = 'running';

    // Fetch user and organization in parallel
    const [user, organization] = await Promise.all([
      this.db.users.findById(userId),
      organizationId ? this.db.organizations.findById(organizationId) : Promise.resolve(null),
    ]);
    if (!user) throw new NotFoundError('User not found');

    const settings = await getSettingsMap(this.db);
    const adminSettingsEnforceCredits = getSettingsValue('enforceCredits', settings);

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
    // Assigned inside the try so a failed lookup lands on the quest as an error rather than
    // escaping this method; the finally's mask cleanup reads it either way.
    let fabFiles: IFabFileDocument[] = [];

    // Persist status='running' + heartbeat updatedAt so a hung/killed edit is recoverable by the
    // check-timeout endpoint. Disposer is cleared in the finally below. See startQuestHeartbeat.
    let stopHeartbeat: (() => void) | undefined;

    try {
      stopHeartbeat = await startQuestHeartbeat(this.db, quest, logger, 'image-edit-heartbeat');

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

      // Access-scoped: a caller-supplied mask id the caller cannot reach is dropped here, never
      // presigned and never fed to a provider as an alpha channel. Lenient on a genuine deny (a
      // dropped id yields no mask rather than an error), matching
      // ImageGenerationService.selectInputImage; the anchor lookup below is the strict one. The
      // `finally` cleanup reads this same list, so an unreachable id also stops reaching
      // deleteFabFile - which already refused it.
      const requestedFabFileIds = [...new Set(fabFileIds ?? [])];
      fabFiles = await this.db.fabFiles.findAccessibleInIds(
        requestedFabFileIds,
        { userId, userGroups: user.groups ?? undefined },
        lakeAccess
      );

      // Leniency is only safe when a drop MEANS "you may not have this". If lake resolution failed
      // we cannot tell that from "we could not check", and the mask slot is positional: dropping
      // the caller's first image silently promotes the next one, so the edit would run on a
      // different input and still bill. Fail before dispatch instead. Gated on an id actually
      // going missing, so a lake outage cannot break edits whose inputs all resolve by ownership.
      if (lakeAccess?.resolutionFailed && fabFiles.length < requestedFabFileIds.length) {
        throw new InternalServerError(
          'Could not verify access to the attached files because the data-lake lookup failed. The edit was not run - please try again.'
        );
      }

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

      // Validate credits before proceeding
      let usageCostUsd = 0;
      if (adminSettingsEnforceCredits && model && this.db.creditTransactions) {
        const { requiredCredits, usdCost } = await this.validateUserCredits(
          user,
          model,
          { size, quality },
          logger,
          organization
        );
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

      const settings = await getSettingsMap(this.db);

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
      const fileImage = fabFiles.find(file => file.mimeType.startsWith('image'));

      // An explicit workbench upload used as the edit mask must not be fed into generation
      // while it's held (pending scan) or blocked. Checked once here, before the per-model
      // branches below each call `fabFileStorage.getSignedUrl` on it.
      if (fileImage && !isImageServeable(fileImage)) {
        throw new BadRequestError('The uploaded image is not available (moderation pending or blocked)');
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
        { userId, type: LLMEvents.QUEUE_HANDLER_IMAGE_GENERATE, metadata: { questId: quest.id, modelId: model } },
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
      const filename = `${uuidv4()}.${fileType?.ext}`;

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

      quest.reply = '';
      quest.replies = [];
      quest.images = [path];
      quest.status = 'done';
      await this.db.quests.update(quest);

      // Remove prompt loading message on the client
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: null,
      });

      // Deduct credits after successful edit
      if (adminSettingsEnforceCredits && typeof quest.creditsUsed === 'number' && this.db.creditTransactions) {
        await deductCreditsWithOrgSupport(
          {
            type: 'image_edit_usage',
            user,
            organization,
            credits: quest.creditsUsed,
            sessionId,
            questId,
            model,
          },
          {
            db: {
              creditTransactions: this.db.creditTransactions,
              users: this.db.users,
              organizations: this.db.organizations,
            },
          }
        );

        // Dual-write usage event: analytics only, never billing.
        this.db.usageEvents
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
            creditsCharged: quest.creditsUsed,
            status: 'ok',
          })
          .catch(err => logger.warn('Failed to record usage event', err));
      }
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
      // Clean up the mask fab files in finally block to ensure they're always deleted
      Logger.globalInstance.debug('[DEBUG] Deleting mask fab files:');
      await Promise.allSettled(
        fabFiles
          .filter(file => file.fileName.startsWith('image_mask'))
          .map(async file => {
            this.deleteFabFile(userId, file.id);
          })
      );
    }
  }
}
