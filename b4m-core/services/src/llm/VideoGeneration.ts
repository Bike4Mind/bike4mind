import { getEffectiveLLMApiKeys, GetEffectiveApiKeyAdapters } from '../apiKeyService';
import {
  GenerateVideoInvokeParamsSchema,
  IChatHistoryItemDocument,
  IConnection,
  ISessionDocument,
  IUserDocument,
  IOrganizationDocument,
  LLMEvents,
  VideoModels,
  VIDEO_SIZE_CONSTRAINTS,
  IChatHistoryItemRepository,
  IUserRepository,
  PromptMeta,
  IAdminSettingsRepository,
  ModelInfo,
  IOrganizationRepository,
  ICreditTransactionRepository,
  IUsageEventRepository,
  CreditHolderType,
} from '@bike4mind/common';
import {
  aiVideoService,
  BadRequestError,
  ClientMessageSender,
  getSettingsMap,
  getSettingsValue,
  isZodError,
  NotFoundError,
  TiktokenTokenizer,
  usdToCredits,
  BaseStorage,
  getSettingsByNames,
} from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { MongoAbility } from '@casl/ability';
import axios from 'axios';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';
import { SoraVideoCostCalculator, SoraCostInput } from './videoCostCalculator/SoraVideoCostCalculator';
import { deductCreditsWithOrgSupport } from '../creditService';
import { startQuestHeartbeat } from './questHeartbeat';
import { insufficientCreditsError, getQuestErrorCode } from '@bike4mind/common';

/**
 * Schema for video generation queue handler body
 */
export const VideoGenerationBodySchema = z.object({
  sessionId: z.string(),
  questId: z.string(),
  userId: z.string(),
  prompt: z.string(),
  model: z.enum(VideoModels).prefault(VideoModels.SORA_2),
  seconds: z.union([z.literal(4), z.literal(8), z.literal(12)]).prefault(4),
  size: z
    .enum(['720x1280', '1280x720', '1024x1792', '1792x1024'] as const)
    .prefault(VIDEO_SIZE_CONSTRAINTS.SORA.defaultSize),
  organizationId: z.string().nullable().optional(),
});

export type VideoGenerationBody = z.infer<typeof VideoGenerationBodySchema>;

interface IVideoGenerationServiceOptions {
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
    creditTransactions?: ICreditTransactionRepository;
    usageEvents?: IUsageEventRepository;
    organizations: IOrganizationRepository;
  } & GetEffectiveApiKeyAdapters['db'];
  startVideoGenerationProcess: (body: VideoGenerationBody) => Promise<void>;
  wsHttpsUrl: string;
  abilityGetter: (user: IUserDocument | undefined) => MongoAbility;
  logEvent: (event: any, options?: { session?: mongoose.ClientSession; ability?: MongoAbility }) => Promise<any>;
  /** Storage where the generated videos will be stored. */
  storage: BaseStorage;
  invokeSessionAutoNaming?: (sessionId: string, userId: string) => Promise<void>;
}

/**
 * Download a video from a URL and return as Buffer
 * @param url - The URL to download from
 * @param apiKey - Optional API key for authenticated endpoints (e.g., OpenAI Sora)
 */
async function downloadVideo(url: string, apiKey?: string): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  const response = await axios.get(url, { responseType: 'arraybuffer', headers });
  return Buffer.from(response.data);
}

/**
 * Video Generation Service
 *
 * Handles video generation requests using OpenAI Sora.
 * Following the same pattern as ImageGenerationService.
 */
export class VideoGenerationService {
  private db: IVideoGenerationServiceOptions['db'];
  private startVideoGenerationProcess: IVideoGenerationServiceOptions['startVideoGenerationProcess'];
  private wsHttpsUrl: string;
  private logEvent: IVideoGenerationServiceOptions['logEvent'];
  private abilityGetter: IVideoGenerationServiceOptions['abilityGetter'];
  private storage: BaseStorage;
  private tokenizer: TiktokenTokenizer;
  private invokeSessionAutoNaming: IVideoGenerationServiceOptions['invokeSessionAutoNaming'];

  constructor(options: IVideoGenerationServiceOptions) {
    this.db = options.db;
    this.startVideoGenerationProcess = options.startVideoGenerationProcess;
    this.wsHttpsUrl = options.wsHttpsUrl;
    this.logEvent = options.logEvent;
    this.storage = options.storage;
    this.abilityGetter = options.abilityGetter;
    this.tokenizer = new TiktokenTokenizer({ logger: Logger.globalInstance });
    this.invokeSessionAutoNaming = options.invokeSessionAutoNaming;
  }

  /**
   * Invoke a video generation request
   * Creates a quest and queues the job for processing
   */
  public async invoke({ body, userId }: { body: z.infer<typeof GenerateVideoInvokeParamsSchema>; userId: string }) {
    const now = new Date();

    const parsedBody = GenerateVideoInvokeParamsSchema.parse(body);
    const { sessionId, prompt, model, questId, seconds, size } = parsedBody;
    const session = await this.db.sessions.findById(sessionId);
    if (!session) throw new NotFoundError('Session not found');

    // Build video parameters
    const videoParameters = {
      model,
      seconds,
      size,
    };

    const promptMeta: Partial<PromptMeta> = {
      model: {
        name: model,
        parameters: videoParameters,
        type: 'video',
      },
      session: {
        id: sessionId,
        userId,
      },
      prompt: prompt,
      questId: questId,
      statusLog: [
        {
          status: 'Video generation started',
          timestamp: now,
        },
      ],
    };

    let quest;
    if (questId) {
      quest = await this.db.quests.findById(questId);
      if (!quest) throw new NotFoundError('Quest not found');
      // If the quest is a retry, clear out the previous state
      quest.videos = [];
      quest.replies = [];
      quest.status = undefined;
      quest.promptMeta = promptMeta;

      await this.db.quests.update(quest);
    } else {
      // Create the associated quest record
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
      Logger.globalInstance.log(`[DEBUG INVOKE] Starting video generation process for quest ${quest.id}...`);

      await this.startVideoGenerationProcess(
        VideoGenerationBodySchema.parse({
          userId: userId,
          questId: quest.id,
          prompt,
          model,
          seconds,
          size,
          sessionId: session.id,
        })
      );

      Logger.globalInstance.log(`[DEBUG INVOKE] Video generation process initiated for quest ${quest.id}`);

      // In development mode, processing happens synchronously
      const isDevelopment = process.env.NODE_ENV === 'development' || process.env.BYPASS_QUEUE === 'true';
      if (isDevelopment) {
        Logger.globalInstance.log(`[DEBUG INVOKE] Development mode: Refetching updated quest...`);
        const updatedQuest = await this.db.quests.findById(quest.id);
        if (updatedQuest) {
          Logger.globalInstance.log(`[DEBUG INVOKE] Returning updated quest:`, {
            id: updatedQuest.id,
            status: updatedQuest.status,
            hasVideos: !!updatedQuest.videos?.length,
            videoCount: updatedQuest.videos?.length,
          });
          return updatedQuest;
        }
      }
    } catch (error) {
      Logger.globalInstance.error(`[DEBUG INVOKE] Error in video generation process:`, error);

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

    return quest;
  }

  /**
   * Validate user has sufficient credits for video generation
   */
  private async validateUserCredits(
    user: IUserDocument,
    modelInfo: ModelInfo,
    input: SoraCostInput,
    logger: Logger,
    organization?: IOrganizationDocument | null
  ) {
    let credits = user.currentCredits ?? 0;
    let creditsSource: 'user' | 'organization' = 'user';

    if (organization) {
      credits = organization.currentCredits ?? 0;
      creditsSource = 'organization';
      logger.updateMetadata({ creditsSource: 'organization', creditsSourceId: organization.id });
    } else {
      logger.updateMetadata({ creditsSource: 'user', creditsSourceId: user.id });
    }

    const costCalculator = new SoraVideoCostCalculator();
    const usdCost = costCalculator.getCost(input);
    const requiredCredits = usdToCredits(usdCost);

    logger.info('[VideoGenerationService] Credit validation', {
      credits,
      creditsSource,
      requiredCredits,
      usdCost,
      model: input.model,
      seconds: input.seconds,
    });

    if (credits < requiredCredits) {
      const sourceLabel = creditsSource === 'organization' ? 'Your organization does' : 'You do';
      throw insufficientCreditsError(
        `${sourceLabel} not have enough credits to complete this video generation. Current credits: ${credits}, required: approximately ${requiredCredits}.`
      );
    }

    // usdCost returned only for usage-event analytics; billing still uses requiredCredits.
    return { requiredCredits, usdCost };
  }

  /**
   * Add a status update to the quest's status log
   */
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

  /**
   * Process a video generation request (called from queue handler)
   */
  public async process({ body, logger }: { body: z.infer<typeof VideoGenerationBodySchema>; logger: Logger }) {
    const startTime = Date.now();
    const { sessionId, questId, userId, prompt, model, seconds, size, organizationId } =
      VideoGenerationBodySchema.parse(body);

    logger.updateMetadata({ notebookId: sessionId, questId, userId, organizationId });

    const quest = await this.db.quests.findById(questId);
    if (!quest) throw new NotFoundError('Quest not found');
    quest.status = 'running';

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
        videos: quest.videos,
        errorCode: quest.errorCode,
      };
    };

    const clientMessageSender = new ClientMessageSender(this.db, logger);
    const wsEndpoint = this.wsHttpsUrl;

    // Persist status='running' + heartbeat updatedAt so a hung/killed render is recoverable by the
    // check-timeout endpoint. Disposer is cleared in the finally below. See startQuestHeartbeat.
    let stopHeartbeat: (() => void) | undefined;

    try {
      stopHeartbeat = await startQuestHeartbeat(this.db, quest, logger, 'video-heartbeat');

      const apiKeyTable = await getEffectiveLLMApiKeys(userId, { db: this.db, getSettingsByNames });
      const models = await getAvailableModels(apiKeyTable);

      if (!apiKeyTable.openai) {
        throw new NotFoundError('OpenAI API Key not found. Video generation requires OpenAI API access.');
      }

      const modelInfo = models.find(m => m.id === model);
      if (!modelInfo) throw new BadRequestError(`Invalid model: "${model}" is not available`);

      // Validate credits before proceeding
      let usageCostUsd = 0;
      if (adminSettingsEnforceCredits && model && !!this.db.creditTransactions) {
        const { requiredCredits, usdCost } = await this.validateUserCredits(
          user,
          modelInfo,
          {
            model: model as VideoModels.SORA_2 | VideoModels.SORA_2_PRO,
            seconds: seconds as 4 | 8 | 12,
            size,
          },
          logger,
          organization
        );
        quest.creditsUsed = requiredCredits;
        usageCostUsd = usdCost;
      }

      this.addStatusToQuest(quest, 'Preparing to generate video...');
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Preparing to generate video...',
      });

      // Create the video service
      const service = aiVideoService('openai', apiKeyTable.openai, logger);

      this.addStatusToQuest(quest, 'Generating video... This may take several minutes.');
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Generating video... This may take several minutes.',
      });

      // Generate the video
      logger.info('[VideoGenerationService] Starting video generation', {
        model,
        seconds,
        size,
        promptLength: prompt.length,
      });

      const videoUrls = await service.generate(prompt, {
        model,
        seconds,
        size,
        user: userId,
      });

      logger.info('[VideoGenerationService] Video generation completed', {
        videoCount: videoUrls.length,
      });

      const userAbility = this.abilityGetter(user);

      await this.logEvent(
        { userId, type: LLMEvents.QUEUE_HANDLER_VIDEO_GENERATE, metadata: { questId: quest.id, modelId: model } },
        { ability: userAbility }
      );

      // Download and store videos to S3
      this.addStatusToQuest(quest, 'Storing your video...');
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: 'Storing your video...',
      });

      const videoPaths = await Promise.all(
        videoUrls.map(async (videoUrl, index) => {
          logger.info('[VideoGenerationService] Processing video for storage', {
            videoUrl: videoUrl.substring(0, 100) + '...',
            index,
            questId,
            model,
          });

          // Pass API key for authenticated download from OpenAI Sora
          const buffer = await downloadVideo(videoUrl, apiKeyTable.openai ?? undefined);
          const filename = `${uuidv4()}.mp4`;

          logger.info('[VideoGenerationService] Uploading video to storage', {
            filename,
            questId,
            model,
            bufferSize: buffer.length,
          });

          const path = await this.storage.upload(buffer, filename, {
            ContentType: 'video/mp4',
          });

          logger.info('[VideoGenerationService] Video uploaded successfully', {
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

      // Update quest with results
      quest.reply = '';
      quest.replies = [];
      quest.videos = videoPaths;
      quest.status = 'done';

      // Update promptMeta with performance data
      if (quest.promptMeta) {
        quest.promptMeta.performance = {
          ...quest.promptMeta.performance,
          totalResponseTime,
          modelInferenceTime: totalResponseTime,
        };
      }

      this.addStatusToQuest(quest, 'Video generation completed');

      logger.info('[VideoGenerationService] Quest updated', {
        id: quest.id,
        status: quest.status,
        hasVideos: !!quest.videos?.length,
        videoCount: quest.videos?.length,
        totalResponseTime,
      });

      await this.db.quests.update(quest);

      if (this.invokeSessionAutoNaming) {
        await this.invokeSessionAutoNaming(sessionId, userId);
      }

      // Notify client of completion
      await clientMessageSender.sendToClient(userId, wsEndpoint, {
        action: 'streamed_chat_completion',
        quest: parseQuestToStreamPayload(quest),
        statusMessage: null,
      });

      // Deduct credits after successful generation
      if (adminSettingsEnforceCredits && typeof quest.creditsUsed === 'number' && !!this.db.creditTransactions) {
        await deductCreditsWithOrgSupport(
          {
            type: 'video_generation_usage',
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
            feature: 'video_generation',
            provider: 'openai',
            model,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            units: seconds,
            costUsd: usageCostUsd,
            creditsCharged: quest.creditsUsed,
            status: 'ok',
            latencyMs: Date.now() - startTime,
          })
          .catch(err => logger.warn('Failed to record usage event', err));
      }
    } catch (error) {
      logger.error('Error processing video generation:', error);
      this.addStatusToQuest(quest, `Error: ${(error as Error).message}`);
      quest.reply = (error as Error).message;
      quest.type = 'error';
      quest.status = 'done';
      // Tag genuine out-of-credits failures so the client renders the "Add Credits" CTA.
      quest.errorCode = getQuestErrorCode(error);
      // Targeted partial update (mirrors ImageGeneration/ImageEdit): a full-object update would
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
    }
  }
}
