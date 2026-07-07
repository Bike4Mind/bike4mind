import { getEffectiveLLMApiKeys, GetEffectiveApiKeyAdapters } from '../apiKeyService';
import {
  IChatHistoryItemDocument,
  IConnection,
  ISessionDocument,
  OpenAIImageGenerationInput,
  IUserDocument,
  LLMEvents,
  ImageModels,
  BFL_SAFETY_TOLERANCE,
  getTextModelCost,
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
} from '@bike4mind/common';
import { BFL_IMAGE_MODELS, isImageServeable } from '@bike4mind/common';
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
import { deductCreditsWithOrgSupport } from '../creditService';
import { moderateImageOrThrow } from './imageModerationGate';
import { startQuestHeartbeat } from './questHeartbeat';
import { insufficientCreditsError, getQuestErrorCode } from '@bike4mind/common';

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
  output_format: z.enum(['jpeg', 'png']).optional().prefault('png'),
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
  size: z.string().optional(),
  fabFileIds: z.array(z.string()).optional(),
  image: z.string(),
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
}

// TODO make these adminSettings
const TRUNCATE_THRESHOLD = 1000;
const TRUNCATE_TO = 980;

async function downloadImage(url: string) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return response.data;
}

async function imageUrlToBase64(imageUrl: string): Promise<string> {
  const data = await downloadImage(imageUrl);
  const buffer = Buffer.from(data, 'binary');
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
    this.deleteFabFile = options.deleteFabFile;
    this.tokenizer = new TiktokenTokenizer({ logger: Logger.globalInstance });
  }

  public async invoke({ body, userId }: { body: z.infer<typeof EditImageRequestBodySchema>; userId: string }) {
    const now = new Date();

    const { sessionId, prompt, model, questId, fabFileIds, organizationId, ...rest } =
      EditImageRequestBodySchema.parse(body);
    if (fabFileIds.length === 0) throw new BadRequestError('No fabFileIds provided');

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
      await this.db.quests.update(quest);
    }

    return quest;
  }

  private async validateUserCredits(
    user: IUserDocument,
    model: string,
    n: number = 1,
    organization?: IOrganizationDocument | null
  ) {
    let credits = user.currentCredits ?? 0;
    let creditsSource: 'user' | 'organization' = 'user';

    // If organization exists, use organization credits instead
    if (organization) {
      credits = organization.currentCredits ?? 0;
      creditsSource = 'organization';
    }

    const apiKeyTable = await getEffectiveLLMApiKeys(user.id, { db: this.db, getSettingsByNames });
    const models = await getAvailableModels(apiKeyTable);
    const modelInfo = models.find(m => m.id === model);
    if (!modelInfo) throw new BadRequestError(`Invalid model: "${model}" is not available`);

    //TODO: Change this to getImageModelCost?
    const usdCost = getTextModelCost(modelInfo, 0, 0);
    const requiredCredits = usdToCredits(usdCost * n);

    if (credits < requiredCredits) {
      const creditsOwner = creditsSource === 'organization' ? 'Your organization does' : 'You do';
      throw insufficientCreditsError(
        `${creditsOwner} not have enough credits to complete this request. ${creditsSource === 'organization' ? 'Organization' : 'You'} currently have ${credits} credits, and this request requires approximately ${requiredCredits} credits. Try reducing the number of images to lower the credit cost.`
      );
    }

    // usdCost returned only for usage-event analytics; billing still uses requiredCredits.
    return { requiredCredits, usdCost: usdCost * n };
  }

  public async process({ body, logger }: { body: z.infer<typeof ImageEditBodySchema>; logger: Logger }) {
    const {
      sessionId,
      questId,
      userId,
      prompt,
      model,
      n = 1,
      safety_tolerance,
      prompt_upsampling,
      seed,
      output_format = 'jpeg',
      aspect_ratio,
      fabFileIds,
      size,
      image: sourceImageUrl,
      organizationId,
    } = ImageEditBodySchema.parse(body);

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
    const fabFiles = await this.db.fabFiles.findAllInIds(fabFileIds || []);

    // Persist status='running' + heartbeat updatedAt so a hung/killed edit is recoverable by the
    // check-timeout endpoint. Disposer is cleared in the finally below. See startQuestHeartbeat.
    let stopHeartbeat: (() => void) | undefined;

    try {
      stopHeartbeat = await startQuestHeartbeat(this.db, quest, logger, 'image-edit-heartbeat');

      const apiKeyTable = await getEffectiveLLMApiKeys(userId, { db: this.db, getSettingsByNames });
      if (!apiKeyTable.openai && !apiKeyTable.bfl) throw new NotFoundError('API Key not found');

      // Validate credits before proceeding
      let usageCostUsd = 0;
      if (adminSettingsEnforceCredits && model && this.db.creditTransactions) {
        const { requiredCredits, usdCost } = await this.validateUserCredits(user, model, n, organization);
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
        const isBFLModelForModeration = Object.values(BFL_IMAGE_MODELS).includes(model as any);
        if (!isBFLModelForModeration && apiKeyTable.openai) {
          await new OpenaiModerationsService(apiKeyTable.openai, logger).checkPrompt(prompt);
        }
      }

      let truncatedPrompt = prompt;

      const models = await getAvailableModels(apiKeyTable);
      const modelMaxTokens = models.find(m => m.id === model)?.max_tokens ?? TRUNCATE_THRESHOLD;

      // Check if prompt exceeds the threshold and truncate if necessary
      if (promptTokens.length > modelMaxTokens) {
        await clientMessageSender.sendToClient(userId, wsEndpoint, {
          action: 'streamed_chat_completion',
          quest: parseQuestToStreamPayload(quest),
          statusMessage: 'Trimming the prompt...',
        });
        truncatedPrompt = promptTokens.slice(0, TRUNCATE_TO).join(' ');
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

      // Choose the appropriate service based on the model
      const isBFLModel = Object.values(BFL_IMAGE_MODELS).includes(model as any);
      const service = isBFLModel
        ? aiImageService('bfl', apiKeyTable.bfl!, logger, this.imageProcessorLambdaName)
        : aiImageService('openai', apiKeyTable.openai!, logger, this.imageProcessorLambdaName);

      let result: string | null = null;
      if (BFL_IMAGE_MODELS.includes(model as any)) {
        // BFL specific options
        const bflModel = ImageModels.FLUX_PRO_FILL;

        Logger.globalInstance.debug(`[DEBUG] Processing BFL image edit:`, {
          model: bflModel,
          aspect_ratio,
        });

        const sourceBase64Image = await imageUrlToBase64(sourceImageUrl);
        const signedUrl = fileImage?.filePath ? await this.fabFileStorage.getSignedUrl(fileImage.filePath) : undefined;
        const maskBase64Image = signedUrl ? await imageUrlToBase64(signedUrl) : undefined;

        if (!maskBase64Image) throw new NotFoundError('Mask image not found');
        if (!sourceBase64Image) throw new NotFoundError('Source image not found');

        // For Pro models, use width and height
        const editResponse: ImageEditResponse = await service.edit(sourceBase64Image, truncatedPrompt, {
          mask: maskBase64Image,
          model: bflModel,
          safety_tolerance,
          prompt_upsampling,
          seed,
          output_format,
        });
        // BFL always returns success (no clarifications)
        if (editResponse.type === 'success') {
          result = editResponse.dataUrl;
        } else {
          throw new InternalServerError('Unexpected response type from BFL image service');
        }
      } else {
        // OpenAI specific options
        Logger.globalInstance.debug(`[DEBUG] Processing OpenAI image edit:`, {
          model,
          aspect_ratio,
        });
        const gptImage1 = ImageModels.GPT_IMAGE_1;

        const sourceBase64Image = await imageUrlToBase64(sourceImageUrl);
        const signedUrl = fileImage?.filePath ? await this.fabFileStorage.getSignedUrl(fileImage.filePath) : undefined;
        const maskBase64Image = signedUrl ? await imageUrlToBase64(signedUrl) : undefined;

        if (!sourceBase64Image) throw new NotFoundError('Source image not found');

        const editResponse: ImageEditResponse = await service.edit(sourceBase64Image, truncatedPrompt, {
          mask: maskBase64Image || null,
          model: gptImage1,
          n: 1,
          size: size as OpenAIImageSize | undefined,
          response_format: 'url',
          user: userId,
        });
        // OpenAI always returns success (no clarifications)
        if (editResponse.type === 'success') {
          result = editResponse.dataUrl;
        } else {
          throw new InternalServerError('Unexpected response type from OpenAI image service');
        }
      }

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

      const buffer = await downloadImage(result);
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
          provider: isBFLModel ? 'bfl' : 'openai',
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
            provider: isBFLModel ? 'bfl' : 'openai',
            model,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            units: n,
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
      // Propagate the machine-readable classifier (e.g. 'insufficient_credits') so the client
      // renders the inline "Add Credits" CTA instead of the dead-end raw error text. Unset for
      // untagged failures, mirroring the chat reservation path's errorCode handling.
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
