import { getEffectiveLLMApiKeys, GetEffectiveApiKeyAdapters } from '../apiKeyService';
import {
  GenerateImageIvokeParamsSchema,
  IChatHistoryItemDocument,
  IConnection,
  ISessionDocument,
  OpenAIImageGenerationInput,
  IUserDocument,
  LLMEvents,
  ImageModels,
  BFLSafetyToleranceSchema,
  OPENAI_IMAGE_SIZES,
  IChatHistoryItemRepository,
  IUserRepository,
  PromptMeta,
  IFabFileRepository,
  IAdminSettingsRepository,
  ModelInfo,
  IOrganizationRepository,
  IOrganizationDocument,
  ICreditTransactionRepository,
  IUsageEventRepository,
  CreditHolderType,
  PromptIntentSchema,
  ImageModerationIncident as ImageModerationIncidentInput,
} from '@bike4mind/common';
import {
  BFL_IMAGE_MODELS,
  XAI_IMAGE_MODELS,
  GEMINI_IMAGE_MODELS,
  isGPTImageModel,
  isGPTImage2Model,
  isGeminiImageModel,
  isImageServeable,
  requiresImageInput,
  insufficientCreditsError,
  getQuestErrorCode,
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
  usdToCredits,
  UnprocessableEntityError,
  OpenAIImageService,
  BFLImageService,
  XAIImageService,
  GeminiImageService,
  ImageEditResponse,
  BaseStorage,
  getSettingsByNames,
  ImageModerationService,
} from '@bike4mind/utils';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { MongoAbility } from '@casl/ability';
import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';
import {
  OpenAICostInput,
  OpenAIGPTImageInput,
  OpenAIImageCostCalculator,
} from './imageCostCalculator/OpenAIImageCostCalculator';
import { FluxImageCostCalculator } from './imageCostCalculator/FluxImageCostCalculator';
import { GeminiImageCostCalculator } from './imageCostCalculator/GeminiImageCostCalculator';
import { CostInput } from './imageCostCalculator/types';
import { deductCreditsWithOrgSupport } from '../creditService';
import { shouldSummarizeSession } from './ChatCompletionFeatures';
import { moderateImageOrThrow } from './imageModerationGate';
import { startQuestHeartbeat } from './questHeartbeat';

/** Maps quality for GPT Image models: standard -> medium, hd -> high; returns quality unchanged for other models. */
function mapQualityForModel(model: string, quality: OpenAIGPTImageInput['quality']): OpenAIGPTImageInput['quality'] {
  if (!isGPTImageModel(model) || !quality) return quality;
  return quality === 'standard' ? 'medium' : quality === 'hd' ? 'high' : quality;
}

export const ImageGenerationBodySchema = OpenAIImageGenerationInput.extend({
  sessionId: z.string(),
  questId: z.string(),
  userId: z.string(),
  prompt: z.string(),
  organizationId: z.string().nullable().optional(),
  safety_tolerance: BFLSafetyToleranceSchema,
  prompt_upsampling: z.boolean().optional().prefault(false),
  seed: z.number().nullable().optional(),
  output_format: z.enum(['jpeg', 'png']).nullable().optional().prefault('png'),
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
  fabFileIds: z.array(z.string()).optional(),
  /** Resolved by the API route. Defaults to 'fresh' if absent. */
  intent: PromptIntentSchema.optional(),
});
export type ImageGenerationBody = z.infer<typeof ImageGenerationBodySchema>;

interface IImageGenerationServiceOptions {
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
  startImageGenerationProcess: (body: ImageGenerationBody) => Promise<void>;
  wsHttpsUrl: string;
  abilityGetter: (user: IUserDocument | undefined) => MongoAbility;
  logEvent: (event: any, options?: { session?: mongoose.ClientSession; ability?: MongoAbility }) => Promise<any>;
  /** Storage where the generated images will be stored. */
  storage: BaseStorage;
  fabFileStorage: BaseStorage;
  invokeSessionAutoNaming?: (sessionId: string, userId: string) => Promise<void>;
  /**
   * Publish a `session.summarize` event so the summarization Lambda runs after image generation.
   * Wiring this lets image-only sessions accumulate long-term context just like chat sessions -
   * the resolver in `resolveImagePrompt` then has more than the last 6 turns to ground on.
   */
  invokeSummarizeSession?: (sessionId: string, trigger: ISessionDocument['summaryTrigger']) => Promise<void>;
  /** Lambda function name for image processing (from SST Resource.ImageProcessor.name) */
  imageProcessorLambdaName?: string;
  /** Checks a generated image for explicit content before it's stored. Optional so existing callers/tests keep compiling; the moderation hook is a no-op when absent. */
  imageModerationService?: ImageModerationService;
}

// TODO make these adminSettings
const TRUNCATE_THRESHOLD = 1000;
const TRUNCATE_TO = 980;

async function downloadImage(url: string) {
  // Handle data URLs (base64 images) from GPT-Image-1
  if (url.startsWith('data:image/')) {
    const base64Data = url.split(',')[1];
    return Buffer.from(base64Data, 'base64');
  }

  // Handle regular URLs from DALL-E and other models
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return response.data;
}

async function imageUrlToBase64(imageUrl: string): Promise<string> {
  const data = await downloadImage(imageUrl);
  const buffer = Buffer.from(data, 'binary');
  return buffer.toString('base64');
}

export class ImageGenerationService {
  private db: IImageGenerationServiceOptions['db'];
  private startImageGenerationProcess: IImageGenerationServiceOptions['startImageGenerationProcess'];
  private wsHttpsUrl: string;
  private logEvent: IImageGenerationServiceOptions['logEvent'];
  private abilityGetter: IImageGenerationServiceOptions['abilityGetter'];
  private storage: BaseStorage;
  private fabFileStorage: BaseStorage;
  private tokenizer: TiktokenTokenizer;
  private invokeSessionAutoNaming: IImageGenerationServiceOptions['invokeSessionAutoNaming'];
  private invokeSummarizeSession: IImageGenerationServiceOptions['invokeSummarizeSession'];
  private imageProcessorLambdaName?: string;
  private imageModerationService?: ImageModerationService;

  constructor(options: IImageGenerationServiceOptions) {
    this.db = options.db;
    this.startImageGenerationProcess = options.startImageGenerationProcess;
    this.wsHttpsUrl = options.wsHttpsUrl;
    this.logEvent = options.logEvent;
    this.storage = options.storage;
    this.fabFileStorage = options.fabFileStorage;
    this.abilityGetter = options.abilityGetter;
    this.tokenizer = new TiktokenTokenizer({ logger: Logger.globalInstance });
    this.invokeSessionAutoNaming = options.invokeSessionAutoNaming;
    this.invokeSummarizeSession = options.invokeSummarizeSession;
    this.imageProcessorLambdaName = options.imageProcessorLambdaName;
    this.imageModerationService = options.imageModerationService;
  }

  /**
   * Fire-and-forget summarization check after a successful image generation. The actual
   * summarization Lambda is async (EventBridge) so this only costs a session read plus
   * one indexed quest count (or zero when throttled). Errors are logged and never propagate -
   * summarization is best-effort and must not affect the image-gen response.
   */
  private async maybeSummarizeAfterImage(sessionId: string, logger: Logger): Promise<void> {
    if (!this.invokeSummarizeSession) return;
    const session = await this.db.sessions.findById(sessionId);
    if (!session) {
      logger.debug(`Skipping image-gen summarize check: session ${sessionId} not found`);
      return;
    }
    const [shouldSummarize, trigger] = await shouldSummarizeSession(session, { db: this.db, logger });
    if (shouldSummarize) {
      logger.info(`Triggering notebook summarization from image-gen for session ${sessionId}`);
      await this.invokeSummarizeSession(sessionId, trigger);
    }
  }

  public async invoke({ body, userId }: { body: z.infer<typeof GenerateImageIvokeParamsSchema>; userId: string }) {
    const now = new Date();

    const parsedBody = GenerateImageIvokeParamsSchema.parse(body);
    const { sessionId, prompt, model, questId, fabFileIds, promptEnhancement, organizationId, intent, ...rest } =
      parsedBody;
    const session = await this.db.sessions.findById(sessionId);
    if (!session) throw new NotFoundError('Session not found');

    // Filter out undefined values from parameters
    const imageParameters = Object.fromEntries(
      Object.entries({
        // Extract OpenAI image generation parameters from the rest object
        n: rest.n,
        quality: rest.quality,
        style: rest.style,
        size: rest.size,
        width: rest.width,
        height: rest.height,
        aspect_ratio: rest.aspect_ratio,
        response_format: rest.response_format,
        // BFL-specific parameters - these may not be available in GenerateImageRequestBodySchema
        safety_tolerance: (parsedBody as any).safety_tolerance,
        prompt_upsampling: (parsedBody as any).prompt_upsampling,
        seed: (parsedBody as any).seed,
        output_format: (parsedBody as any).output_format,
      }).filter(([_, value]) => value !== undefined)
    );

    // Get session message history to build proper context
    const recentMessages = await this.db.quests.getMostRecentChatHistory(sessionId, 50);
    const totalMessageCount = recentMessages.length + 1; // +1 for this image generation request

    // The user's literal text - used for the chat bubble, transcript, and userPrompt telemetry.
    // The body's `prompt` (potentially rewritten by the resolver) is what flows to the image model.
    const displayPrompt = promptEnhancement?.originalPrompt ?? prompt;

    const promptMeta: Partial<PromptMeta> = {
      model: {
        name: model,
        parameters: imageParameters,
        type: 'image',
      },
      session: {
        id: sessionId,
        userId,
      },
      prompt: prompt,
      questId: questId,
      // Build comprehensive context similar to ChatCompletion
      context: {
        totalMessageCount: totalMessageCount,
        mementoCount: 0, // Image generation doesn't use mementos
        systemPrompt: 'Image generation request',
        userPrompt: displayPrompt,
        // Initialize file tracking (will be populated if fabFileIds are provided)
        attachedFiles: fabFileIds?.map(id => ({ id })) || [],
        // System prompt tracking (images don't typically use system prompts)
        sessionFileIds: [],
        messageFileIds: [],
        globalSystemFileIds: [],
        userSystemFileIds: [],
        projectSystemFileIds: [],
        dedupedSystemPrompts: [],
        totalSystemPromptCount: 0,
        duplicateSystemPromptCount: 0,
      },
      performance: {
        // Will be populated during processing
      },
      statusLog: [
        {
          status: 'Image generation started',
          timestamp: now,
        },
      ],
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

      if (promptEnhancement) {
        quest.promptEnhancement = promptEnhancement;
      }

      await this.db.quests.update(quest);
    } else {
      // Persist the user's literal prompt on the quest so the chat bubble shows what they actually
      // typed. The body's `prompt` carries the resolver's rewritten version (used by `process()` for
      // the image-model call) - these intentionally diverge for continuations so the rewrite stays
      // an implementation detail rather than appearing in the user's voice.
      quest = await this.db.quests.create({
        sessionId,
        prompt: displayPrompt,
        type: 'message',
        timestamp: now,
        replies: [],
        promptMeta,
        promptEnhancement,
      });
    }

    try {
      Logger.globalInstance.log(`[DEBUG INVOKE] Starting image generation process for quest ${quest.id}...`);

      await this.startImageGenerationProcess(
        ImageGenerationBodySchema.parse({
          userId: userId,
          questId: quest.id,
          prompt,
          model,
          ...rest,
          sessionId: session.id,
          fabFileIds,
          promptEnhancement,
          organizationId,
          intent,
        })
      );

      Logger.globalInstance.log(`[DEBUG INVOKE] Image generation process initiated for quest ${quest.id}`);

      // In development mode, processing happens synchronously, so we should return the updated quest
      const isDevelopment = process.env.NODE_ENV === 'development' || process.env.BYPASS_QUEUE === 'true';
      if (isDevelopment) {
        Logger.globalInstance.log(`[DEBUG INVOKE] Development mode: Refetching updated quest...`);
        const updatedQuest = await this.db.quests.findById(quest.id);
        if (updatedQuest) {
          Logger.globalInstance.log(`[DEBUG INVOKE] ✅ Returning updated quest:`, {
            id: updatedQuest.id,
            status: updatedQuest.status,
            hasImages: !!updatedQuest.images?.length,
            imageCount: updatedQuest.images?.length,
          });
          return updatedQuest;
        } else {
          Logger.globalInstance.log(`[DEBUG INVOKE] ⚠️ Could not refetch quest, returning original`);
        }
      }
    } catch (error) {
      Logger.globalInstance.error(`[DEBUG INVOKE] Error in image generation process:`, error);

      let errorMessage = `Something went wrong. Please try again.`;
      if (isZodError(error)) {
        errorMessage = fromZodError(error).message;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      quest.type = 'error';
      quest.reply = errorMessage;
      await this.db.quests.update(quest);
    }

    Logger.globalInstance.log(`[DEBUG INVOKE] Returning quest:`, {
      id: quest.id,
      status: quest.status,
      hasImages: !!quest.images?.length,
      imageCount: quest.images?.length,
    });
    return quest;
  }

  private async validateUserCredits(
    user: IUserDocument,
    modelInfo: ModelInfo,
    n: number = 1,
    input: CostInput,
    logger: Logger,
    organization?: IOrganizationDocument | null
  ) {
    let credits = user.currentCredits ?? 0;
    let creditsSource: 'user' | 'organization' = 'user';

    // If organization exists, use organization credits instead
    if (organization) {
      credits = organization.currentCredits ?? 0;
      creditsSource = 'organization';
      logger.updateMetadata({ creditsSource: 'organization', creditsSourceId: organization.id });
    } else {
      logger.updateMetadata({ creditsSource: 'user', creditsSourceId: user.id });
    }

    let usdCost = 0;

    if (isGPTImageModel(modelInfo.id)) {
      const openAiCostCalculator = new OpenAIImageCostCalculator();
      usdCost = openAiCostCalculator.getCost(input as OpenAICostInput);
    } else if (
      modelInfo.id === ImageModels.FLUX_PRO_ULTRA ||
      modelInfo.id === ImageModels.FLUX_PRO_1_1 ||
      modelInfo.id === ImageModels.FLUX_PRO ||
      modelInfo.id === ImageModels.FLUX_KONTEXT_PRO ||
      modelInfo.id === ImageModels.FLUX_KONTEXT_MAX
    ) {
      const fluxCostCalculator = new FluxImageCostCalculator();
      usdCost = fluxCostCalculator.getCost({
        model: modelInfo.id,
      });
    } else if (modelInfo.id === ImageModels.GROK_IMAGINE_IMAGE_QUALITY) {
      usdCost = 0.055;
    } else if (isGeminiImageModel(modelInfo.id)) {
      // Gemini image generation cost
      const geminiCostCalculator = new GeminiImageCostCalculator();
      usdCost = geminiCostCalculator.getCost({
        model: modelInfo.id,
      });
    } else {
      logger.error(`No cost calculator found for model: ${modelInfo.id}`);
      throw new BadRequestError(`Model not supported: "${modelInfo.id}"`);
    }

    const requiredCredits = usdToCredits(usdCost * n);

    if (!Number.isFinite(requiredCredits)) {
      throw new InternalServerError(`Unable to compute credit cost for model "${modelInfo.id}" (got ${usdCost}).`);
    }

    if (credits < requiredCredits) {
      const creditsOwner = creditsSource === 'organization' ? 'Your organization does' : 'You do';
      throw insufficientCreditsError(
        `${creditsOwner} not have enough credits to complete this request. ${creditsSource === 'organization' ? 'Organization' : 'You'} currently have ${credits} credits, and this request requires approximately ${requiredCredits} credits. Try reducing the number of images to lower the credit cost.`
      );
    }

    // usdCost returned only for usage-event analytics; billing still uses requiredCredits.
    return { requiredCredits, usdCost: usdCost * n };
  }

  private addStatusToQuest(quest: IChatHistoryItemDocument, status: string) {
    if (!quest.promptMeta) {
      quest.promptMeta = {};
    }
    if (!quest.promptMeta.statusLog) {
      quest.promptMeta.statusLog = [];
    }
    quest.promptMeta.statusLog.push({
      status,
      timestamp: new Date(),
    });
  }

  public async process({ body, logger }: { body: z.infer<typeof ImageGenerationBodySchema>; logger: Logger }) {
    const startTime = Date.now();
    const {
      sessionId,
      questId,
      userId,
      prompt,
      model,
      n = 1,
      width,
      height,
      size,
      quality,
      style,
      safety_tolerance,
      prompt_upsampling,
      seed,
      output_format,
      aspect_ratio,
      fabFileIds,
      organizationId,
      intent = 'fresh',
    } = ImageGenerationBodySchema.parse(body);

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

    // Persist status='running' + heartbeat updatedAt so a hung/killed render is recoverable by the
    // check-timeout endpoint. Disposer is cleared in the finally below. See startQuestHeartbeat.
    let stopHeartbeat: (() => void) | undefined;

    try {
      stopHeartbeat = await startQuestHeartbeat(this.db, quest, logger, 'image-heartbeat');

      const apiKeyTable = await getEffectiveLLMApiKeys(userId, { db: this.db, getSettingsByNames });
      const models = await getAvailableModels(apiKeyTable);
      if (!apiKeyTable.openai && !apiKeyTable.bfl && !apiKeyTable.xai && !apiKeyTable.gemini)
        throw new NotFoundError('API Key not found');
      const modelInfo = models.find(m => m.id === model);
      if (!modelInfo) throw new BadRequestError(`Invalid model: "${model}" is not available`);
      if (apiKeyTable[modelInfo.backend as keyof typeof apiKeyTable] === 'expired')
        throw new InternalServerError(`Model API key is expired for backend: "${modelInfo.backend}"`);

      // For GPT image models (except gpt-image-2 which supports flexible sizes),
      // normalize size to a valid GPT size. BFL sizes like '1440x810'
      // can reach here if the user switched models without resetting their size selection.
      const effectiveSize =
        isGPTImageModel(model) &&
        !isGPTImage2Model(model) &&
        size &&
        !(OPENAI_IMAGE_SIZES as readonly string[]).includes(size)
          ? (OPENAI_IMAGE_SIZES[0] as string)
          : size;

      // Validate credits before proceeding
      let usageCostUsd = 0;
      if (adminSettingsEnforceCredits && model && !!this.db.creditTransactions) {
        const { requiredCredits, usdCost } = await this.validateUserCredits(
          user,
          modelInfo,
          n,
          {
            model,
            size: effectiveSize,
            quality: mapQualityForModel(model, quality),
          },
          logger,
          organization
        );
        quest.creditsUsed = requiredCredits;
        usageCostUsd = usdCost;
      }

      // Encode the prompt to tokens
      const promptTokens = await this.tokenizer.encodeTokens(prompt, model);

      this.addStatusToQuest(quest, 'Preparing to paint...');
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Preparing to paint...',
      });

      const settings = await getSettingsMap(this.db);

      if (getSettingsValue('ModerationEnabled', settings)) {
        this.addStatusToQuest(quest, 'Checking prompt...');
        await clientMessageSender.sendToClient(userId, wsEndpoint, {
          action: 'streamed_chat_completion',
          quest: parseQuestToStreamPayload(quest),
          statusMessage: 'Checking prompt...',
        });
        // Only moderate if using OpenAI (BFL models have their own safety_tolerance)
        const isBFLModelForModeration = Object.values(BFL_IMAGE_MODELS).includes(model as any);
        if (!isBFLModelForModeration && apiKeyTable.openai) {
          await new OpenaiModerationsService(apiKeyTable.openai, logger).checkPrompt(prompt);
        }
      }

      let truncatedPrompt = prompt;

      const modelMaxTokens = models.find(m => m.id === model)?.max_tokens ?? TRUNCATE_THRESHOLD;

      // Check if prompt exceeds the threshold and truncate if necessary
      if (promptTokens.length > modelMaxTokens) {
        this.addStatusToQuest(quest, 'Trimming the prompt...');
        await clientMessageSender.sendToClient(userId, wsEndpoint, {
          action: 'streamed_chat_completion',
          quest: parseQuestToStreamPayload(quest),
          statusMessage: 'Trimming the prompt...',
        });
        truncatedPrompt = promptTokens.slice(0, TRUNCATE_TO).join(' ');
      }

      this.addStatusToQuest(quest, 'Now painting...');
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Now painting...',
      });

      // Image selection: workbench file (explicit user intent) wins; otherwise carry forward
      // the most recent session image when the model accepts image input AND the prompt resolver
      // classified the user's intent as a continuation of a prior image. Required-input models
      // (Kontext) always attempt to load a prior image and throw later if none is available.
      //
      // Two source shapes are possible: a full workbench IFabFileDocument (rich metadata) or a
      // synthesized stub from session history (just filePath + mimeType). The fields downstream
      // dispatch actually reads are filePath and mimeType; everything else (id, fileName) is
      // optional and only used for logging. `filePath` matches IFabFileDocument's nullable shape.
      type SelectedImage = { filePath?: string; mimeType: string; id?: string; fileName?: string };
      const fabFiles = await this.db.fabFiles.findAllInIds(fabFileIds || []);
      const workbenchImage = fabFiles.find(file => file.mimeType.startsWith('image'));

      // An explicit workbench upload the user attached for image-to-image must not be fed into
      // generation while it's held (pending scan) or blocked. Checked once here - before it's
      // fanned out to any of the per-model `fabFileStorage.getSignedUrl` branches below - since
      // every branch that reads an uploaded file routes through `workbenchImage`.
      if (workbenchImage && !isImageServeable(workbenchImage)) {
        throw new BadRequestError('The uploaded image is not available (moderation pending or blocked)');
      }

      let fileImage: SelectedImage | undefined = workbenchImage;
      let imageSource: 'workbench' | 'message_history' = 'workbench';

      if (!fileImage) {
        const shouldCarryForwardSessionImage =
          requiresImageInput(model) || (modelInfo.supportsImageVariation && intent === 'continuation');

        logger.debug('Image selection (no workbench file)', {
          model,
          intent,
          supportsImageVariation: modelInfo.supportsImageVariation,
          requiresImageInput: requiresImageInput(model),
          shouldCarryForwardSessionImage,
        });

        if (shouldCarryForwardSessionImage) {
          const recentMessages = await this.db.quests.getMostRecentChatHistory(sessionId, 50);
          const messageWithImage = recentMessages.find(
            msg => msg.images && msg.images.length > 0 && msg.type !== 'error'
          );

          if (messageWithImage?.images?.length) {
            fileImage = {
              filePath: messageWithImage.images[0],
              mimeType: 'image/png',
            };
            imageSource = 'message_history';
            logger.debug('Carrying forward prior session image', {
              messageId: messageWithImage.id,
              timestamp: messageWithImage.timestamp,
            });
          } else {
            logger.debug('No prior session image available to carry forward');
          }
        }
      }

      logger.debug('Image selection result', {
        hasImage: !!fileImage,
        imageSource,
        imageId: fileImage?.id,
        fileName: fileImage?.fileName,
      });

      // Choose the appropriate service based on the model
      const isBFLModel = Object.values(BFL_IMAGE_MODELS).includes(model as any);
      const isXAIModel = Object.values(XAI_IMAGE_MODELS).includes(model as any);
      const isGeminiModel = Object.values(GEMINI_IMAGE_MODELS).includes(model as any);

      let service: OpenAIImageService | BFLImageService | XAIImageService | GeminiImageService;
      if (isBFLModel) {
        service = aiImageService('bfl', apiKeyTable.bfl!, logger, this.imageProcessorLambdaName);
      } else if (isXAIModel) {
        service = aiImageService('xai', apiKeyTable.xai!, logger, this.imageProcessorLambdaName);
      } else if (isGeminiModel) {
        service = aiImageService('gemini', apiKeyTable.gemini!, logger, this.imageProcessorLambdaName);
      } else {
        service = aiImageService('openai', apiKeyTable.openai!, logger, this.imageProcessorLambdaName);
      }

      let images: string[] = [];
      if (XAI_IMAGE_MODELS.includes(model as any)) {
        Logger.globalInstance.debug(`[DEBUG] === XAI IMAGE PROCESSING ===`);

        // XAI specific options - simplified for basic text-to-image generation
        Logger.globalInstance.debug(`[DEBUG] XAI model parameters:`, {
          model,
          promptLength: truncatedPrompt.length,
          n,
        });

        images = await service.generate(truncatedPrompt, {
          model: model as any,
          n,
          user: userId,
        });
      } else if (GEMINI_IMAGE_MODELS.includes(model as any)) {
        Logger.globalInstance.debug(`[DEBUG] === GEMINI IMAGE PROCESSING ===`);

        // Gemini specific options
        Logger.globalInstance.debug(`[DEBUG] Gemini model parameters:`, {
          model,
          promptLength: truncatedPrompt.length,
          n,
          aspect_ratio,
          output_format,
          safety_tolerance,
        });

        const geminiService = service as GeminiImageService;
        let base64Image: string | undefined;

        if (fileImage?.filePath) {
          try {
            let imageUrl: string | undefined;
            if (imageSource === 'workbench' && fileImage.filePath) {
              Logger.globalInstance.debug(`[DEBUG] Gemini edit: generating signed URL for workbench image`);
              imageUrl = await this.fabFileStorage.getSignedUrl(fileImage.filePath);
            } else if (imageSource === 'message_history' && fileImage.filePath) {
              // Message history images are stored as S3 keys (filenames), not full URLs
              // Need to get a signed URL to access them
              Logger.globalInstance.debug(`[DEBUG] Gemini edit: generating signed URL for message history image`);
              imageUrl = await this.storage.getSignedUrl(fileImage.filePath);
            } else {
              imageUrl = fileImage.filePath;
            }

            if (imageUrl) {
              Logger.globalInstance.debug(`[DEBUG] Gemini edit: converting input image to base64`, {
                urlPreview: imageUrl.substring(0, 100) + '...',
              });
              base64Image = await imageUrlToBase64(imageUrl);
              Logger.globalInstance.debug(`[DEBUG] Gemini edit: base64 conversion successful`, {
                length: base64Image.length,
              });
            }
          } catch (error) {
            Logger.globalInstance.error(
              `[DEBUG] Gemini edit: failed to prepare input image, falling back to text-to-image`,
              error
            );
            base64Image = undefined;
          }
        }

        if (base64Image) {
          const preparedImage = base64Image;
          Logger.globalInstance.debug(`[DEBUG] Gemini edit: using existing image input`, {
            n,
            aspect_ratio,
            output_format,
            safety_tolerance,
          });
          const editPromises = Array.from({ length: n }, () =>
            geminiService.edit(preparedImage, truncatedPrompt, {
              aspect_ratio,
              output_format,
              safety_tolerance,
            })
          );
          const editResponses: ImageEditResponse[] = await Promise.all(editPromises);

          // Check if any responses are clarifications
          const clarificationResponse = editResponses.find(
            (response): response is Extract<ImageEditResponse, { type: 'clarification' }> =>
              response.type === 'clarification'
          );

          if (clarificationResponse) {
            // Gemini is requesting clarification
            Logger.globalInstance.debug('[DEBUG] Gemini is requesting clarification:', {
              clarificationId: clarificationResponse.clarificationId,
              questionPreview: clarificationResponse.question.substring(0, 100) + '...',
            });

            // Store clarification in quest and send to client
            quest.reply = `**Clarification Needed:**\n\n${clarificationResponse.question}\n\n_Please provide more details about what you'd like me to do with the image._`;
            quest.type = 'message'; // Keep as message type so user can respond
            quest.status = 'done';

            // Store clarification metadata for potential future retry
            if (!quest.promptMeta) {
              quest.promptMeta = {};
            }
            (quest.promptMeta as any).imageClarification = {
              clarificationId: clarificationResponse.clarificationId,
              question: clarificationResponse.question,
              originalPrompt: clarificationResponse.originalPrompt,
              timestamp: new Date(),
            };

            this.addStatusToQuest(quest, 'Clarification requested');
            await this.db.quests.update(quest);
            await clientMessageSender.sendToClient(userId, wsEndpoint, {
              action: 'streamed_chat_completion',
              quest: parseQuestToStreamPayload(quest),
              statusMessage: null,
            });

            // Exit early - don't try to process images
            return;
          }

          // All responses are successful, extract data URLs
          images = editResponses.map((response: ImageEditResponse) => {
            if (response.type === 'success') {
              return response.dataUrl;
            }
            throw new InternalServerError('Unexpected response type from image service');
          });
        } else {
          Logger.globalInstance.debug(`[DEBUG] Gemini generation: proceeding without input image`);
          images = await geminiService.generate(truncatedPrompt, {
            model: model as any,
            n,
            aspect_ratio,
            output_format,
            safety_tolerance,
          });
        }
      } else if (BFL_IMAGE_MODELS.includes(model as any)) {
        Logger.globalInstance.debug(`[DEBUG] === BFL IMAGE PROCESSING ===`);
        // BFL specific options
        const isKontextModel = requiresImageInput(model);
        const isBFLUltraModel = model === ImageModels.FLUX_PRO_ULTRA;

        Logger.globalInstance.debug(`[DEBUG] BFL model analysis:`, {
          model,
          isKontextModel,
          isBFLUltraModel,
          width,
          height,
          aspect_ratio,
          output_format,
          safety_tolerance,
          prompt_upsampling,
          seed,
        });

        // Handle different image sources
        let imageUrl: string | undefined;
        Logger.globalInstance.debug(`[DEBUG] Processing image URL for source: ${imageSource}`);

        if (fileImage?.filePath) {
          Logger.globalInstance.debug(
            `[DEBUG] FileImage filePath exists:`,
            fileImage.filePath.substring(0, 100) + '...'
          );

          if (imageSource === 'workbench') {
            Logger.globalInstance.debug(`[DEBUG] Getting signed URL for workbench file...`);
            try {
              imageUrl = await this.fabFileStorage.getSignedUrl(fileImage.filePath);
              Logger.globalInstance.debug(`[DEBUG] ✅ Got signed URL:`, imageUrl.substring(0, 100) + '...');
            } catch (error) {
              Logger.globalInstance.error(`[DEBUG] ❌ Error getting signed URL:`, error);
              throw error;
            }
          } else {
            // Message history images are stored as S3 keys (filenames), not full URLs
            // Need to get a signed URL to access them from the generated images storage
            Logger.globalInstance.debug(`[DEBUG] Getting signed URL for message history image...`);
            try {
              imageUrl = await this.storage.getSignedUrl(fileImage.filePath);
              Logger.globalInstance.debug(
                `[DEBUG] ✅ Got signed URL for message history:`,
                imageUrl.substring(0, 100) + '...'
              );
            } catch (error) {
              Logger.globalInstance.error(`[DEBUG] ❌ Error getting signed URL for message history:`, error);
              throw error;
            }
          }
        } else {
          Logger.globalInstance.debug(`[DEBUG] ⚠️ No fileImage.filePath available`);
        }

        Logger.globalInstance.debug(`[DEBUG] Converting image URL to base64...`, {
          hasImageUrl: !!imageUrl,
          urlLength: imageUrl?.length,
        });

        let base64Image: string | undefined;
        if (imageUrl) {
          try {
            base64Image = await imageUrlToBase64(imageUrl);
            Logger.globalInstance.debug(`[DEBUG] ✅ Base64 conversion successful:`, {
              base64Length: base64Image.length,
              preview: base64Image.substring(0, 50) + '...',
            });
          } catch (error) {
            Logger.globalInstance.error(`[DEBUG] ❌ Error converting to base64:`, error);
            throw error;
          }
        } else {
          Logger.globalInstance.debug(`[DEBUG] ⚠️ No imageUrl available for base64 conversion`);
        }

        if (isKontextModel) {
          Logger.globalInstance.debug(`[DEBUG] === KONTEXT MODEL PROCESSING ===`);
          Logger.globalInstance.debug(`[DEBUG] Kontext model validation:`, {
            hasBase64Image: !!base64Image,
            base64ImageLength: base64Image?.length,
            model,
            truncatedPromptLength: truncatedPrompt.length,
          });

          // Kontext models require an input image for transformation
          if (!base64Image) {
            const errorMsg =
              '❌ Kontext models require an input image for transformation. Please either:\n1. Upload an image to the workbench, or\n2. Generate an image in this conversation first.\n\nTip: Try generating an image with a text-to-image model first (like Flux Pro or GPT-Image), then apply Kontext transformations.';
            Logger.globalInstance.error(`[DEBUG] ❌ Kontext validation failed:`, errorMsg);
            throw new UnprocessableEntityError(errorMsg);
          }

          Logger.globalInstance.debug(`[DEBUG] ✅ Kontext validation passed, calling transform...`);

          const transformParams = {
            model: model as ImageModels.FLUX_KONTEXT_PRO | ImageModels.FLUX_KONTEXT_MAX,
            safety_tolerance,
            prompt_upsampling,
            seed,
            output_format,
            aspect_ratio,
          };

          Logger.globalInstance.debug(`[DEBUG] Transform parameters:`, transformParams);
          Logger.globalInstance.debug(`[DEBUG] Prompt preview:`, truncatedPrompt.substring(0, 100) + '...');

          try {
            const transformedImage = await (service as any).transform(base64Image, truncatedPrompt, transformParams);
            Logger.globalInstance.debug(`[DEBUG] ✅ Transform successful:`, {
              resultType: typeof transformedImage,
              resultLength: transformedImage?.length,
              resultPreview: transformedImage?.substring(0, 100) + '...',
            });
            images = [transformedImage];
          } catch (error) {
            Logger.globalInstance.error(`[DEBUG] ❌ Transform failed:`, error);
            throw error;
          }
        } else if (isBFLUltraModel) {
          // For Ultra models, use aspect_ratio
          images = await service.generate(truncatedPrompt, {
            width: undefined,
            height: undefined,
            aspect_ratio: aspect_ratio || '16:9',
            user: userId,
            model: ImageModels.FLUX_PRO_ULTRA,
            safety_tolerance,
            prompt_upsampling,
            image_prompt: base64Image,
            seed,
            output_format,
            n,
          });
        } else {
          // For regular Pro models, use width and height
          images = await service.generate(truncatedPrompt, {
            width: width || 1024,
            height: height || 768,
            user: userId,
            model: model as any,
            safety_tolerance,
            image_prompt: base64Image,
            prompt_upsampling,
            seed,
            output_format,
            n,
          });
        }
      } else {
        Logger.globalInstance.debug(`[DEBUG] === OPENAI IMAGE PROCESSING ===`);

        // OpenAI specific options - use effectiveSize which has already been normalized
        // to a valid GPT size to guard against BFL-specific sizes being passed here
        const openAiSize = effectiveSize && effectiveSize !== '1024x768' ? effectiveSize : undefined;

        // Handle different image sources
        let imageUrl: string | undefined;
        if (fileImage?.filePath) {
          Logger.globalInstance.debug(`[DEBUG] Processing OpenAI with input image from ${imageSource}`);
          if (imageSource === 'workbench') {
            // Workbench files need signed URLs
            imageUrl = await this.fabFileStorage.getSignedUrl(fileImage.filePath);
            Logger.globalInstance.debug(`[DEBUG] ✅ Got signed URL for workbench image`);
          } else {
            // Message history images are stored as S3 keys (filenames), not full URLs
            // Need to get a signed URL to access them from the generated images storage
            imageUrl = await this.storage.getSignedUrl(fileImage.filePath);
            Logger.globalInstance.debug(`[DEBUG] ✅ Got signed URL for message history image`);
          }
        } else {
          Logger.globalInstance.debug(
            `[DEBUG] ✅ Processing OpenAI for pure text-to-image generation (no input image)`
          );
        }

        // Prepare OpenAI parameters with proper filtering for GPT-Image-1
        const openaiParams: any = {
          model: model as any,
          n,
          size: openAiSize as (typeof OPENAI_IMAGE_SIZES)[number] | undefined,
          user: userId,
        };

        // Filter parameters based on model type
        if (isGPTImageModel(model)) {
          // GPT-Image models don't support 'style' or 'response_format' parameters
          // Use mapped quality (standard -> medium, hd -> high)
          const mappedQuality = mapQualityForModel(model, quality);
          if (mappedQuality) {
            openaiParams.quality = mappedQuality;
          }
        } else {
          // Other OpenAI models support these parameters
          openaiParams.quality = quality;
          openaiParams.style = style;
          openaiParams.response_format = 'url';
        }

        openaiParams.imagePrompt = imageUrl;

        Logger.globalInstance.debug(`[DEBUG] OpenAI API call parameters:`, {
          model,
          hasImagePrompt: !!imageUrl,
          generationType: imageUrl ? 'image variation' : 'text-to-image',
          size: openaiParams.size,
          quality: openaiParams.quality,
          style: openaiParams.style,
          n: openaiParams.n,
        });

        images = await service.generate(truncatedPrompt, openaiParams);
      }

      const userAbility = this.abilityGetter(user);

      await this.logEvent(
        { userId, type: LLMEvents.QUEUE_HANDLER_IMAGE_GENERATE, metadata: { questId: quest.id, modelId: model } },
        { ability: userAbility }
      );

      // download images and store to s3
      this.addStatusToQuest(quest, 'Tucking your image into storage...');
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Tucking your image into storage...',
      });

      const imagePaths = await Promise.all(
        images.map(async (image, index) => {
          Logger.globalInstance.debug('[DEBUG] Processing image for storage:', {
            imageUrl: image,
            index,
            questId,
            model,
          });

          const buffer = await downloadImage(image);
          const fileType = await fileTypeFromBuffer(buffer);
          const filename = `${uuidv4()}.${fileType?.ext}`;

          await moderateImageOrThrow({
            service: this.imageModerationService,
            // `?? true`: fail toward moderation-ON. getSettingsValue already returns true when
            // the row is absent (default ON); the fallback guards a future refactor that could
            // return undefined - for a legal-safety control the safe last resort is enabled.
            enabled: getSettingsValue('ImageModerationEnabled', settings) ?? true,
            incidents: this.db.imageModerationIncidents,
            buffer,
            mimeType: `image/${fileType?.ext ?? 'png'}`,
            incidentMeta: { userId, sessionId: quest.sessionId, questId, provider: modelInfo.backend, model },
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

          return path;
        })
      );

      this.addStatusToQuest(quest, 'Adding to the notebook...');
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Adding to the notebook...',
      });

      const endTime = Date.now();
      const totalResponseTime = endTime - startTime;

      Logger.globalInstance.debug(`[DEBUG] Updating quest with final results...`);
      quest.reply = '';
      quest.replies = [];
      quest.images = imagePaths;
      quest.status = 'done';

      // Update promptMeta with performance data
      if (quest.promptMeta) {
        quest.promptMeta.performance = {
          ...quest.promptMeta.performance,
          totalResponseTime,
          modelInferenceTime: totalResponseTime, // For images, inference is the main time component
        };
        // Update context information
        if (quest.promptMeta.context) {
          quest.promptMeta.context.totalMessageCount = 1;
        }
        // Add generated image references
        quest.promptMeta.generatedImageReferences = imagePaths;
      }

      // Add final status
      this.addStatusToQuest(quest, 'Image generation completed');

      Logger.globalInstance.debug(`[DEBUG] Quest before update:`, {
        id: quest.id,
        status: quest.status,
        hasImages: !!quest.images?.length,
        imageCount: quest.images?.length,
        imageUrls: quest.images?.map(url => url.substring(0, 100) + '...'),
        totalResponseTime,
      });

      await this.db.quests.update(quest);

      if (this.invokeSessionAutoNaming) {
        await this.invokeSessionAutoNaming(sessionId, userId);
      }

      this.maybeSummarizeAfterImage(sessionId, logger).catch(err =>
        logger.error('Error in fire-and-forget image-gen summarize check:', err)
      );

      // Verify the update by fetching the quest
      const verificationQuest = await this.db.quests.findById(quest.id);
      Logger.globalInstance.debug(`[DEBUG] ✅ Quest updated and verified:`, {
        id: quest.id,
        status: quest.status,
        hasImages: !!quest.images?.length,
        imageCount: quest.images?.length,
        verificationStatus: verificationQuest?.status,
        verificationHasImages: !!verificationQuest?.images?.length,
        verificationImageCount: verificationQuest?.images?.length,
      });

      // Remove prompt loading message on the client
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: null,
      });

      // Deduct credits after successful generation
      if (
        adminSettingsEnforceCredits &&
        typeof quest.creditsUsed === 'number' &&
        Number.isFinite(quest.creditsUsed) &&
        !!this.db.creditTransactions
      ) {
        await deductCreditsWithOrgSupport(
          {
            type: 'image_generation_usage',
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
            feature: 'image_generation',
            provider: modelInfo.backend,
            model,
            // Prompt tokens actually sent to the model: the full encoded prompt, or TRUNCATE_TO
            // when it was trimmed above (see the modelMaxTokens branch). Image models bill
            // per-image (costUsd/units), so this is analytics-only completeness, not billing.
            inputTokens: promptTokens.length > modelMaxTokens ? TRUNCATE_TO : promptTokens.length,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            units: n,
            costUsd: usageCostUsd,
            creditsCharged: quest.creditsUsed,
            status: 'ok',
            latencyMs: Date.now() - startTime,
          })
          .catch(err => logger.warn('Failed to record usage event', err));
      }
    } catch (error) {
      logger.error('Error processing image generation:', error);
      this.addStatusToQuest(quest, `Error: ${(error as Error).message}`);
      quest.reply = (error as Error).message;
      quest.type = 'error';
      quest.status = 'done';
      // Tag genuine out-of-credits failures so the client renders the "Add Credits" CTA.
      quest.errorCode = getQuestErrorCode(error);
      // Targeted partial update: only persist the error fields. A full-object update would
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
      // Always stop the heartbeat, on success, error, or an early return (e.g. Gemini
      // clarification). The terminal write above owns the final status.
      stopHeartbeat?.();
    }
  }
}
