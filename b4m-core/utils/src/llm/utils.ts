import {
  dayjs,
  extractSnippetMeta,
  ICacheRepository,
  IChatHistoryItemRepository,
  IExtendedMessage,
  IFabFileChunkRepository,
  IFabFileDocument,
  IFabFileRepository,
  IMessage,
  isImageServeable,
  ISessionDocument,
  MessageContent,
  MessageContentObject,
  MessageContentText,
  MessageContentToolUse,
  ModelBackend,
  ModelInfo,
  OpenAIEmbeddingModel,
  SupportedEmbeddingModel,
} from '@bike4mind/common';
import {
  BaseStorage,
  EmbeddingFactory,
  EmbeddingService,
  detectURLs,
  fetchAndParseURL,
  hasURLs,
} from '@bike4mind/fab-pipeline';
import { getSettingsValue } from '../settings';
import { Logger } from '@bike4mind/observability';
import { ensureToolPairingIntegrity } from '@bike4mind/llm-adapters';
import { getFileContent } from '../fabfile';
import { BadRequestError, CorruptedFileError } from '../errors';
import { isAxiosError } from 'axios';
import { ITokenizer } from '../tokenCounting';
import { getFileType } from '../file';
const INFINITE_VALUE = 14;
const MAX_FILE_SIZE = 6000;
/** Cap on generated images surfaced to the model for editing (keeps the context note small). */
const MAX_RECENT_GENERATED_IMAGES = 6;
/** Chars of the originating prompt kept per generated image, for context without bloat. */
const RECENT_IMAGE_PROMPT_PREVIEW_CHARS = 120;
/** quest.images also holds non-image generated artifacts (e.g. .xlsx); only these extensions are editable. */
const EDITABLE_IMAGE_KEY_RE = /\.(jpe?g|png|webp|gif)$/i;
const PREVIEW_CHUNK = 700;
const CHARS_PER_TOKEN = 3.5;

// Bedrock limits images to 2000px max dimension for multi-image requests.
// Since conversations accumulate images over time, always enforce this limit.
const MAX_IMAGE_DIMENSION_PX = 2000;

// Emergency token limits for embedding generation
const EMBEDDING_TOKEN_LIMITS = {
  MAX_EMBEDDING_TOKENS: 8000, // Conservative limit under 8192
  CHUNK_OVERLAP: 100, // Overlap between chunks for continuity
};

// Context Management Constants
/**
 * Floor for the context-overflow buffer, used when 5% of the context window is under 1000 tokens.
 * Covers token-estimation error (10-20% between estimate and tokenizer), special-token and
 * formatting overhead (role tags, separators), and output headroom.
 */
const MIN_TOKEN_BUFFER = 1000;

/**
 * Fraction of the context window reserved as buffer (5%).
 * Covers token-count drift between estimate and encoder and special tokens (BOS, EOS, role
 * markers), and keeps input+output from exactly hitting the context limit.
 */
const TOKEN_BUFFER_PERCENTAGE = 0.05;

/**
 * Share of the token budget given to knowledge/fab files when history + files overflow: 70% files,
 * 30% history. Users attach files expecting them used; history can be pruned more aggressively.
 */
const KNOWLEDGE_FILE_TOKEN_ALLOCATION = 0.7;

const estimateTokenLength = (text: string): number => {
  // Rough estimate: ~3.5 chars per token for English text
  return Math.ceil(text.length / CHARS_PER_TOKEN);
};

/**
 * Safely generate embeddings for text that might exceed token limits
 * Chunks large text and returns averaged embedding vector
 */
export async function generateSafeEmbedding(
  embeddingService: EmbeddingService,
  text: string,
  logger: Logger
): Promise<number[]> {
  const modelInfo = embeddingService.getModelInfo();
  const maxTokens = Math.min(modelInfo.contextWindow - 100, EMBEDDING_TOKEN_LIMITS.MAX_EMBEDDING_TOKENS);

  const estimatedTokens = estimateTokenLength(text);

  logger.info('Safe embedding generation', {
    textLength: text.length,
    estimatedTokens,
    maxTokens,
    needsChunking: estimatedTokens > maxTokens,
  });

  if (estimatedTokens <= maxTokens) {
    logger.info(`Using embedder ${embeddingService.getModelInfo().model} `);
    return await embeddingService.generateEmbedding(text);
  }

  // Text is too large - chunk it and average the embeddings
  logger.warn(`Text exceeds embedding token limit (${estimatedTokens} > ${maxTokens}), chunking...`);

  const maxChunkLength = Math.floor(maxTokens * 3.5); // Convert tokens back to characters
  const chunks: string[] = [];

  // Create overlapping chunks
  for (let i = 0; i < text.length; i += maxChunkLength - EMBEDDING_TOKEN_LIMITS.CHUNK_OVERLAP) {
    const chunk = text.slice(i, i + maxChunkLength);
    if (chunk.trim().length > 0) {
      chunks.push(chunk);
    }
  }

  logger.info(`Created ${chunks.length} chunks for embedding`);

  const chunkEmbeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const embedding = await embeddingService.generateEmbedding(chunks[i]);
      chunkEmbeddings.push(embedding);
      logger.debug(`Generated embedding for chunk ${i + 1}/${chunks.length}`);
    } catch (error) {
      logger.error(`Failed to generate embedding for chunk ${i + 1}:`, error);
      // Skip failed chunks rather than failing entirely
      continue;
    }
  }

  if (chunkEmbeddings.length === 0) {
    throw new Error('Failed to generate embeddings for any chunks');
  }

  // Average the embeddings
  const embeddingDimension = chunkEmbeddings[0].length;
  const averagedEmbedding = new Array(embeddingDimension).fill(0);

  for (const embedding of chunkEmbeddings) {
    for (let i = 0; i < embeddingDimension; i++) {
      averagedEmbedding[i] += embedding[i];
    }
  }

  for (let i = 0; i < embeddingDimension; i++) {
    averagedEmbedding[i] /= chunkEmbeddings.length;
  }

  logger.info(`Successfully generated averaged embedding from ${chunkEmbeddings.length} chunks`);
  return averagedEmbedding;
}

/**
 * Return the previous messages from the database, and the total number of previous messages.
 */
export async function fetchAndProcessPreviousMessages(
  session: ISessionDocument,
  historyCount: number | null = null,
  {
    db,
  }: {
    db: {
      quests: Pick<IChatHistoryItemRepository, 'getMostRecentChatHistory'>;
    };
  }
): Promise<
  [
    IMessage[],
    number,
    {
      cacheHit?: boolean;
      fetchTime?: number;
      itemCount?: number;
      oldestIncludedQuestId?: string | null;
      /** Recently generated images (bare storage keys + originating prompt), newest first. */
      recentGeneratedImages?: { key: string; prompt: string }[];
    },
  ]
> {
  if (historyCount !== null && historyCount <= 0) return [[], 0, { cacheHit: false }];

  const limit = historyCount ?? INFINITE_VALUE;

  // Query with descending timestamp, to get the <limit> most-recent messages
  // Add 1 to the limit to account for the current prompt
  const startTime = Date.now();
  const chatHistoryItems = await db.quests.getMostRecentChatHistory(session.id, limit + 1);
  const fetchTime = Date.now() - startTime;

  // Cache-performance telemetry (fetch under 50ms treated as a cache hit).
  const cacheIndicator = fetchTime < 50 ? 'CACHE_HIT' : 'CACHE_MISS';
  Logger.globalInstance.log(
    `⚡ Message History ${cacheIndicator}: ${fetchTime}ms for session ${session.id.slice(-8)} (${
      chatHistoryItems.length
    } items)`
  );

  // Reverse the chat history items and remove the last item (the current prompt)
  chatHistoryItems.reverse();

  // Keep the current prompt if it is the only item, so a session's first prompt stays in history.
  if (chatHistoryItems.length > 1) {
    chatHistoryItems.pop();
  }

  // Filter out messages already covered by contextSummary.
  // MongoDB ObjectIds are time-ordered; string comparison gives correct temporal ordering.
  if (session.contextSummaryUpToQuestId) {
    const boundary = session.contextSummaryUpToQuestId;
    const filtered = chatHistoryItems.filter(item => item.id > boundary);
    chatHistoryItems.splice(0, chatHistoryItems.length, ...filtered);
  }
  const oldestIncludedQuestId = chatHistoryItems[0]?.id ?? null;

  // Convert to IMessage format with tool pairing reconstruction.
  const convertedMessages = chatHistoryItems.reduce((acc, cur) => {
    if (cur.prompt) acc.push({ role: 'user', content: cur.prompt });

    // Priority 1: Use structuredReplies if available (new field for complete tool context)
    if (cur.structuredReplies && cur.structuredReplies.length > 0) {
      for (const structuredReply of cur.structuredReplies) {
        acc.push({
          role: 'assistant',
          content: structuredReply.content,
        });
      }
      if (cur.toolResults && cur.toolResults.length > 0) {
        acc.push({
          role: 'user',
          content: cur.toolResults.map(tr => ({
            type: 'tool_result' as const,
            tool_use_id: tr.tool_use_id,
            content: tr.content,
            is_error: tr.is_error,
          })),
        });
      }
    }
    // Priority 2: Reconstruct from promptMeta.functionCalls if tool IDs exist (fallback)
    else if (
      cur.promptMeta?.functionCalls &&
      cur.promptMeta.functionCalls.length > 0 &&
      cur.promptMeta.functionCalls.some(fc => fc.id)
    ) {
      // Get text reply (excluding thinking blocks)
      const textReply = cur.replies?.find((reply: string) => !reply.trim().startsWith('<think>')) || '';

      // Build assistant message with text + tool_use blocks
      const assistantContent: MessageContentObject[] = [];

      if (textReply) {
        assistantContent.push({ type: 'text', text: textReply } as MessageContentText);
      }

      for (const fc of cur.promptMeta.functionCalls) {
        if (fc.id && fc.name) {
          assistantContent.push({
            type: 'tool_use',
            id: fc.id,
            name: fc.name,
            input: (fc.parameters as Record<string, unknown>) || {},
          } as MessageContentToolUse);
        }
      }

      if (assistantContent.length > 0) {
        acc.push({ role: 'assistant', content: assistantContent });

        // Add a tool_result for each function call that had a tool_use block. returnValue is
        // often unpopulated during completion saving, so we generate a tool_result for every
        // tool_use to maintain Anthropic's required pairing. Filter matches the tool_use
        // generation above (fc.id && fc.name) to keep pairs consistent.
        const toolResults = cur.promptMeta.functionCalls
          .filter(fc => fc.id && fc.name)
          .map(fc => ({
            type: 'tool_result' as const,
            tool_use_id: fc.id!,
            content: fc.returnValue ?? (fc.success === false ? 'Tool execution failed' : ''),
            is_error: fc.success === false,
          }));

        if (toolResults.length > 0) {
          acc.push({ role: 'user', content: toolResults });
        }
      }
    }
    // Priority 3: Legacy fallback - text-only replies
    else if (cur.replies && Array.isArray(cur.replies)) {
      // Do not include thoughts on the chat history. Only actual answers.
      const validReply = cur.replies.find((reply: string) => !reply.trim().startsWith('<think>'));
      if (validReply) acc.push({ role: 'assistant', content: validReply });
    }

    return acc;
  }, new Array<IMessage>());

  // Surface recently generated images so a follow-up turn can edit them
  // ("make it cartoonish"). Generated images persist as bare storage keys in
  // quest.images with no fabFile record, so the model otherwise has no handle on
  // them. Newest first, capped, and filtered to actual image files (quest.images
  // can also hold .xlsx/other generated artifacts).
  const recentGeneratedImages: { key: string; prompt: string }[] = [];
  for (let i = chatHistoryItems.length - 1; i >= 0 && recentGeneratedImages.length < MAX_RECENT_GENERATED_IMAGES; i--) {
    const item = chatHistoryItems[i];
    if (!Array.isArray(item.images) || item.images.length === 0) continue;
    const prompt = (item.prompt ?? '').slice(0, RECENT_IMAGE_PROMPT_PREVIEW_CHARS);
    for (const key of item.images) {
      if (recentGeneratedImages.length >= MAX_RECENT_GENERATED_IMAGES) break;
      if (typeof key === 'string' && EDITABLE_IMAGE_KEY_RE.test(key)) {
        recentGeneratedImages.push({ key, prompt });
      }
    }
  }

  return [
    convertedMessages,
    chatHistoryItems.length,
    {
      cacheHit: fetchTime < 50,
      fetchTime,
      itemCount: chatHistoryItems.length,
      oldestIncludedQuestId,
      recentGeneratedImages,
    },
  ];
}

/**
 * Load recent session history as plain user/assistant text turns for seeding an agent run
 * (`ReActAgent` `previousMessages`).
 *
 * Distinct from `fetchAndProcessPreviousMessages` on two points that matter for the agent path:
 *  1. It does NOT pop the most-recent item. The agent executor does not persist the current user
 *     message as a Quest before running, so the latest stored quest IS the prior turn (the one
 *     containing the follow-up question) and must be kept.
 *  2. It returns text-only turns and skips tool_use/tool_result blocks. The agent appends the
 *     current query as a user message directly after these, with no `buildAndSortMessages`
 *     post-processing, so emitting structured/tool messages here risks dangling tool_result
 *     sequences that the provider rejects. Turns do NOT strictly alternate: a quest whose
 *     only reply is a thinking block yields a user turn with no following assistant, so two user
 *     turns can land in a row (and the sequence may end on a user turn, adjacent to the agent's
 *     appended query). Backends collapse consecutive same-role messages before dispatch (e.g.
 *     `AnthropicBackend.filterRelevantMessages`), so this is benign for seeding context.
 */
export async function fetchAgentConversationHistory(
  session: ISessionDocument,
  questCount: number,
  {
    db,
  }: {
    db: {
      quests: Pick<IChatHistoryItemRepository, 'getMostRecentChatHistory'>;
    };
  }
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  if (questCount <= 0) return [];

  const chatHistoryItems = await db.quests.getMostRecentChatHistory(session.id, questCount);
  // getMostRecentChatHistory returns newest-first; flip to chronological order.
  chatHistoryItems.reverse();

  // Drop turns already folded into a context summary (same boundary the chat path applies).
  // MongoDB ObjectIds are time-ordered, so string comparison gives correct temporal ordering.
  const items = session.contextSummaryUpToQuestId
    ? chatHistoryItems.filter(item => item.id > session.contextSummaryUpToQuestId!)
    : chatHistoryItems;

  return items.reduce((acc, cur) => {
    if (cur.prompt) acc.push({ role: 'user', content: cur.prompt });
    // First reply that isn't a thinking block; matches the text-only fallback in
    // fetchAndProcessPreviousMessages so the agent sees the actual answer, not internal thoughts.
    const textReply = cur.replies?.find((reply: string) => !reply.trim().startsWith('<think>'));
    if (textReply) acc.push({ role: 'assistant', content: textReply });
    return acc;
  }, new Array<{ role: 'user' | 'assistant'; content: string }>());
}

export async function fetchAndConvertFabFiles(
  fabFileIds: string[],
  { scope }: { scope: Record<string, unknown> },
  {
    db,
    storage,
  }: {
    db: {
      fabfiles: Pick<IFabFileRepository, 'getAccessibleFiles'>;
      caches: ICacheRepository;
    };
    storage: BaseStorage;
  }
): Promise<IFabFileDocument[]> {
  const fabFiles = await db.fabfiles.getAccessibleFiles(fabFileIds, scope);

  const convertedFabFiles: IFabFileDocument[] = await Promise.all(
    fabFiles.map(async (file: any) => {
      return {
        ...file,
        userId: file.userId.toString(),
      };
    })
  );
  return convertedFabFiles;
}

export async function getCachedSignedUrl(
  filePath: string,
  storage: BaseStorage,
  db: { caches: ICacheRepository }
): Promise<string> {
  const key = `cachedSignedUrl:${filePath}`;

  const cachedSignedUrl = await db.caches.findByKey(key);
  if (cachedSignedUrl) {
    return cachedSignedUrl.result;
  }

  const expiryInSeconds = 3600; // 1 hour
  const signedUrl = await storage.getSignedUrl(filePath, 'get', { expiresIn: expiryInSeconds });
  const expiresAt = dayjs()
    .add(expiryInSeconds * 1000, 'milliseconds')
    .toDate();
  await db.caches.createOrUpdate({ key, result: signedUrl, expiresAt });
  return signedUrl;
}

// When estimateOnly=false this uses the WASM tiktoken encoder for accurate counts (fast since
// tiktoken v1.0.21+). Reuse the tokenizer's encoder cache across requests (singleton) to avoid
// repeated WASM instantiation.
export async function calculateTotalTokenLength(
  messages: IMessage[],
  { estimateOnly = false, tokenizer }: { estimateOnly?: boolean; tokenizer: ITokenizer }
): Promise<number> {
  let concatenatedContent = '';
  let imageTokenCount = 0;

  messages.forEach(message => {
    concatenatedContent += message.role;

    if (Array.isArray(message.content)) {
      message.content.forEach((obj: any) => {
        if (obj.type === 'image' || obj.type === 'image_url') {
          // Both Anthropic ('image') and OpenAI ('image_url'): exact token cost needs decoding
          // the image (Anthropic ~ width*height/750; OpenAI varies by detail level, low=85). We
          // can't compute that here, so assume ~1600 ("normal"). CRITICAL: without this branch,
          // base64 image data would be JSON.stringify'd and counted as text, causing massive
          // overflow (e.g. 2.7M tokens).
          imageTokenCount += 1600;
        } else {
          concatenatedContent += JSON.stringify(obj);
        }
      });
    } else {
      concatenatedContent += message.content || '';
    }
  });

  // Encode the concatenated content only once
  const textTokens = estimateOnly
    ? estimateTokenLength(concatenatedContent)
    : await tokenizer.countTokens(concatenatedContent);
  return textTokens + imageTokenCount;
}

interface UrlArrays {
  imageUrls: string[];
  nonImageUrls: string[];
}

function separateUrls(urls: string[]): UrlArrays {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
  const imageUrls = urls.filter(url => {
    const lowercaseUrl = url.toLowerCase();
    return imageExtensions.some(ext => lowercaseUrl.endsWith(ext));
  });
  const nonImageUrls = urls.filter(url => !imageExtensions.some(ext => url.toLowerCase().endsWith(ext)));
  return { imageUrls, nonImageUrls };
}

/**
 * Sanitize URL for logging by removing sensitive query parameters.
 * This prevents leaking tokens, API keys, or session IDs in logs.
 */
function sanitizeUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    const sensitiveParams = [
      'token',
      'key',
      'api_key',
      'apikey',
      'secret',
      'password',
      'session',
      'auth',
      'access_token',
    ];
    sensitiveParams.forEach(param => {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
      }
    });
    return parsed.toString();
  } catch {
    // If URL parsing fails, return truncated URL
    return url.substring(0, 100) + (url.length > 100 ? '...' : '');
  }
}

export async function processUrlsFromPrompt(
  userPrompt: string,
  maxContentBuffer: number,
  userId: string,
  sendStatusUpdate: (status: string) => Promise<void>,
  logger: Logger,
  options: { verbose: boolean } = { verbose: false }
): Promise<{ userMessages: IMessage[]; remainingPrompt: string }> {
  // Early return guard - check for URLs before doing any expensive operations
  if (!hasURLs(userPrompt)) {
    if (options?.verbose) {
      logger.log('No URLs detected in prompt, skipping URL processing');
    }
    return { userMessages: [], remainingPrompt: userPrompt };
  }

  // Per-request cache for URL content to avoid redundant fetching within the same request.
  // SECURITY: intentionally function-scoped (not module-level) to prevent cross-session or
  // cross-user data leakage in AWS Lambda warm starts.
  const urlContentCache = new Map<string, string>();

  sendStatusUpdate('Processing URLs from user prompt...');

  const userMessages: IMessage[] = [];
  const promptMeta = extractSnippetMeta(userPrompt);
  const urls = promptMeta.sections // don't include URLs inside code snippets
    .filter(s => s.type !== 'snippet')
    .map(s => detectURLs(s.content))
    .flat();
  const { imageUrls, nonImageUrls } = separateUrls(urls);

  if (options?.verbose) {
    logger.log(
      `Found ${urls.length} URLs: ${urls} and ${imageUrls.length} image URLs and ${nonImageUrls.length} non-image URLs.`
    );
  }

  const processedUrls: string[] = [];

  // Process image URLs
  if (imageUrls.length > 0) {
    const imageContent: MessageContentObject[] = imageUrls.map(url => ({
      type: 'image_url',
      image_url: {
        url: url,
      },
    }));
    const message: IMessage = {
      role: 'user',
      content: imageContent,
    };
    userMessages.push(message);
    processedUrls.push(...imageUrls);
  }
  // Process non-image URLs with per-request caching (dedupes same URL within single prompt)
  const nonImageUrlPromises = nonImageUrls.map(async url => {
    try {
      // Check per-request cache first (dedupes if same URL appears multiple times in prompt)
      const cached = urlContentCache.get(url);
      let textContent: string;

      if (cached) {
        // SECURITY LOG: Track cache hits for audit trail
        logger.info('URL_FETCH', {
          userId,
          url: sanitizeUrlForLogging(url),
          cacheHit: true,
          source: 'same-request-dedup',
        });
        textContent = cached;
      } else {
        const result = await fetchAndParseURL(url, { logger });
        if (typeof result.textContent !== 'string') throw new Error('textContent is not a string');
        textContent = result.textContent;

        // SECURITY LOG: Track URL fetches for audit trail
        logger.info('URL_FETCH', {
          userId,
          url: sanitizeUrlForLogging(url),
          cacheHit: false,
          contentLength: textContent.length,
        });

        // Cache the result for this request only
        urlContentCache.set(url, textContent);
      }

      const message: IMessage = {
        role: 'user',
        content: `For context: ${textContent.substring(0, maxContentBuffer!)}`,
      };
      processedUrls.push(url);
      return message;
    } catch (error) {
      // We don't want to throw an error here, just log it and continue
      logger.warn(`Failed to process non-image URL: ${url}`, error);
      return null;
    }
  });

  const nonImageResults = await Promise.all(nonImageUrlPromises);
  nonImageResults.forEach(result => {
    if (result) {
      userMessages.push(result);
    }
  });

  // Remove processed URLs from the user prompt
  const remainingPrompt = userPrompt.replace(new RegExp(processedUrls.join('|'), 'gi'), '').trim();

  return { userMessages, remainingPrompt };
}

/**
 * Computes cosine similarity between two vectors
 * Returns a value between -1 and 1, where 1 means identical, 0 means orthogonal, -1 means opposite
 */
export function computeCosineSimilarity(vector1: number[], vector2: number[]): number {
  const dotProduct = vector1.reduce((sum, value, index) => sum + value * vector2[index], 0);
  const magnitude1 = Math.sqrt(vector1.reduce((sum, value) => sum + value * value, 0));
  const magnitude2 = Math.sqrt(vector2.reduce((sum, value) => sum + value * value, 0));
  return dotProduct / (magnitude1 * magnitude2);
}

async function cosineSearch(
  file: IFabFileDocument,
  userPromptVector: number[],
  {
    db,
    logger,
  }: {
    db: {
      fabfilechunks: Pick<IFabFileChunkRepository, 'findByFabFileId'>;
    };
    logger: Logger;
  }
): Promise<Array<{ chunkId: string; content: string; score: number }>> {
  const chunks = await db.fabfilechunks.findByFabFileId(file.id);

  const searchResults = chunks
    .map((chunk: any) => {
      const score = computeCosineSimilarity(userPromptVector, chunk.vector!);
      return { chunkId: chunk.id, content: chunk.text, score };
    })
    .filter((result: any) => result !== null);

  // Sort the results based on similarity scores and return top 3
  return searchResults.sort((a: any, b: any) => b.score - a.score).slice(0, 3);
}

/**
 * Supported output MIME types for jimp's getBuffer.
 * Used to validate the detected mime before re-encoding.
 */
const JIMP_SUPPORTED_MIMES = new Set([
  'image/bmp',
  'image/x-ms-bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
]);

/**
 * Ensures an image buffer's dimensions do not exceed the max allowed pixels.
 * Bedrock rejects images >2000px in multi-image requests.
 * Returns the original buffer unchanged if already within limits.
 * Uses jimp (pure JS) instead of sharp to avoid native dependency issues in Lambda.
 */
async function ensureImageWithinDimensionLimit(
  imageBuffer: Buffer,
  maxDimension: number = MAX_IMAGE_DIMENSION_PX,
  logger?: Logger
): Promise<Buffer> {
  try {
    // Dynamic import: jimp is only needed by server-side callers (Lambda, services).
    // A static import would cause bundlers (e.g., CLI's tsdown) to mark jimp as an
    // external dependency even though the CLI never calls this function.
    const { Jimp } = await import('jimp');
    const image = await Jimp.read(imageBuffer);
    const { width, height } = image.bitmap;

    if (width <= maxDimension && height <= maxDimension) {
      return imageBuffer;
    }

    // Scale down preserving aspect ratio so the longest edge = maxDimension
    const scale = maxDimension / Math.max(width, height);
    const newWidth = Math.floor(width * scale);
    const newHeight = Math.floor(height * scale);

    logger?.info(`[ensureImageWithinDimensionLimit] Resizing from ${width}x${height} to ${newWidth}x${newHeight}`);

    const resized = image.resize({ w: newWidth, h: newHeight });

    // Re-encode in original format if jimp supports it, otherwise fall back to PNG
    const outputMime = image.mime && JIMP_SUPPORTED_MIMES.has(image.mime) ? image.mime : 'image/png';
    // jimp's getBuffer generic constraint requires a specific mime literal union;
    // we've already validated the value against JIMP_SUPPORTED_MIMES above
    return Buffer.from(await resized.getBuffer(outputMime as 'image/png'));
  } catch (error) {
    // If resize fails (corrupt image, unsupported format), return the original buffer
    // and let the downstream API call surface any errors naturally
    logger?.warn(`[ensureImageWithinDimensionLimit] Failed to resize image, using original: ${error}`);
    return imageBuffer;
  }
}

export async function processFabFilesServer(
  embeddingFactory: EmbeddingFactory,
  fabFiles: IFabFileDocument[],
  userPrompt: string,
  maxTokens: number,
  modelInfo: ModelInfo,
  sendStatusUpdate: (status: string) => Promise<void>,
  {
    logger,
    storage,
    db,
  }: {
    logger: Logger;
    storage: BaseStorage;
    db: {
      fabfilechunks: Pick<IFabFileChunkRepository, 'findByFabFileId'>;
      fabfiles: Pick<IFabFileRepository, 'update'>;
      caches: ICacheRepository;
    };
  },
  progressCallback?: (progress: number, total: number) => Promise<void>
): Promise<{ userMessages: IMessage[]; errorMessages: IExtendedMessage[] }> {
  if (!fabFiles || fabFiles.length === 0) {
    return { userMessages: [], errorMessages: [] };
  }

  const fileProcessingStartTime = Date.now();
  let systemContent = '';
  const userMessages: IMessage[] = [];
  const errorMessages: IExtendedMessage[] = [];

  // Collect non-system file contents to combine into a single context message
  const contextFiles: { fileName: string; content: string }[] = [];

  const supportsVision = modelInfo?.supportsVision ?? false;

  if (fabFiles.length > 0) {
    sendStatusUpdate('Munching attached files...');
  }

  const imageContent: MessageContentObject[] = [];

  // Process files in parallel, batched by concurrency limit.
  const concurrencyLimit = process.env.FILE_PROCESSING_CONCURRENCY
    ? parseInt(process.env.FILE_PROCESSING_CONCURRENCY)
    : 6;
  const chunks = [];
  for (let i = 0; i < fabFiles.length; i += concurrencyLimit) {
    chunks.push(fabFiles.slice(i, i + concurrencyLimit));
  }

  let processedFiles = 0;
  const totalFiles = fabFiles.length;

  // Memoize the user prompt vectorization for each embedding model
  const embeddingStartTime = Date.now();
  const userVectorPrompt: { [embeddingModel: string]: number[] } = {};
  const selectedEmbeddingModel = embeddingFactory.getDefaultEmbeddingModel();

  if (!userVectorPrompt[selectedEmbeddingModel]) {
    // TODO: Optimize this. Currently taking 1-2 seconds to vectorize user prompt
    userVectorPrompt[selectedEmbeddingModel] = await generateSafeEmbedding(
      embeddingFactory.createEmbeddingService(selectedEmbeddingModel),
      userPrompt,
      logger
    );
  }

  const embeddingTime = Date.now() - embeddingStartTime;
  logger.info(`🕐 [processFabFilesServer] User prompt embedding completed in ${embeddingTime}ms`);

  // Cache for file content to avoid redundant processing
  const fileContentCache = new Map<string, string>();

  const processFileInParallel = async (file: IFabFileDocument): Promise<void> => {
    try {
      if (supportsVision && file.mimeType.startsWith('image/')) {
        // Never send a not-yet-clean or blocked uploaded image to the model.
        if (!isImageServeable(file)) {
          logger.warn(
            `[processFabFilesServer] Skipping image file ${file.fileName} — held pending moderation or blocked (#9776 Q2b).`
          );
          return;
        }

        sendStatusUpdate(`Processing image file ${file.fileName}...`);

        const fileUrl = file.filePath ? await getCachedSignedUrl(file.filePath, storage, db) : undefined;
        if (!fileUrl) {
          throw new Error(`Failed to get signed URL for file ${file.fileName}`);
        }

        switch (modelInfo?.backend) {
          case ModelBackend.OpenAI:
          case ModelBackend.XAI: {
            // Download image from S3 and send as base64 data URL.
            // Presigned S3 URLs cause timeouts when OpenAI/XAI servers try to fetch them.
            const openaiImageBuffer = await storage.download(file.filePath!);
            const { mime: openaiMimeType } = await getFileType(openaiImageBuffer, file.fileName, file.mimeType);
            const openaiBase64 = openaiImageBuffer.toString('base64');

            imageContent.push({
              type: 'image_url',
              image_url: {
                url: `data:${openaiMimeType};base64,${openaiBase64}`,
              },
            });
            // Add filename and fabFileId as text context to prevent hallucinated filenames
            imageContent.push({
              type: 'text',
              text: `Image URL: ${fileUrl}\nFile: "${file.fileName}" (fabFileId: ${file.id})\nWhen referencing this file, use the exact filename "${file.fileName}" — do not rename based on image content.`,
            });
            break;
          }

          case ModelBackend.Anthropic:
          case ModelBackend.Gemini:
          case ModelBackend.Bedrock:
            if (
              modelInfo.backend === ModelBackend.Anthropic ||
              modelInfo.id.includes('anthropic') ||
              modelInfo.id.includes('gemini')
            ) {
              // Check image size before downloading (Anthropic has 5MB base64 limit)
              // We use 3.5MB as safe threshold since base64 encoding adds ~33% overhead
              const MAX_IMAGE_SIZE_MB = 3.5;
              const fileSizeMB = file.fileSize / (1024 * 1024);

              if (fileSizeMB > MAX_IMAGE_SIZE_MB) {
                const backendName = modelInfo.backend.toUpperCase();
                const errorMsg = `⚠️ Image "${file.fileName}" (${fileSizeMB.toFixed(1)}MB) is too large for ${backendName}. Max: ${MAX_IMAGE_SIZE_MB}MB. Please delete this file and re-upload to auto-resize.`;

                logger.warn(errorMsg);
                await sendStatusUpdate(errorMsg);

                // Skip this image but continue processing other files
                errorMessages.push({
                  role: 'error',
                  content: errorMsg,
                });

                return;
              }

              // Download image, enforce dimension limit, and detect actual format
              const rawImageBuffer = await storage.download(file.filePath!);
              const imageBuffer = await ensureImageWithinDimensionLimit(rawImageBuffer, MAX_IMAGE_DIMENSION_PX, logger);
              const imageData = imageBuffer.toString('base64');

              // Detect actual mime type from buffer to avoid mismatches with Anthropic API
              const { mime: actualMimeType } = await getFileType(imageBuffer, file.fileName, file.mimeType);

              imageContent.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: actualMimeType,
                  data: imageData,
                },
              });
              // Add filename and fabFileId as text context to prevent hallucinated filenames
              imageContent.push({
                type: 'text',
                text: `Image URL: ${fileUrl}\nFile: "${file.fileName}" (fabFileId: ${file.id})\nWhen referencing this file, use the exact filename "${file.fileName}" — do not rename based on image content.`,
              });
            } else {
              logger.warn(
                `Vision support for the model ${modelInfo.id} is not implemented. Skipping image processing.`
              );
            }

            break;

          default:
            logger.error(`Unsupported backend for model ${modelInfo.id} backend ${modelInfo?.backend ?? 'undefined'}`);
            break;
        }
      } else if (!supportsVision && file.mimeType.startsWith('image/')) {
        logger.warn(`File ${file.fileName} is an image but model does not support vision. Skipping...`);
      } else {
        if (file.vectorized) {
          // Perform cosine search for vectorized content
          sendStatusUpdate('Now doing retrieval augmented search');

          // Files without embeddingModel are old files that were vectorized with the default embedding model
          // which is text-embedding-ada-002
          const embeddingModel =
            (file.embeddingModel as SupportedEmbeddingModel) ?? OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002;

          const userVector = userVectorPrompt[embeddingModel];

          if (!userVector || userVector.length === 0) {
            logger.warn(
              `No user vector found for embedding model ${embeddingModel}, skipping cosine search for file ${file.fileName}`
            );
            return;
          }

          // clear error message if the file has been vectorized
          if (file.error?.startsWith('Knowledge in the workbench with the fileName')) {
            await db.fabfiles.update({ id: file.id, error: null });
          }

          const searchResults = await cosineSearch(file, userVector, { db, logger });

          // Truncate search results to fit within the token budget
          const maxChars = maxTokens > 0 ? maxTokens * CHARS_PER_TOKEN : MAX_FILE_SIZE;
          const truncatedResults: Array<{ chunkId: string; content: string; score: number }> = [];
          let totalChars = 0;

          for (const result of searchResults) {
            const contentLength = result.content?.length ?? 0;
            if (totalChars + contentLength > maxChars && truncatedResults.length > 0) {
              break;
            }
            if (contentLength > maxChars - totalChars) {
              const content = result.content.substring(0, maxChars - totalChars);
              truncatedResults.push({ ...result, content });
              totalChars = maxChars;
              logger.warn(
                `[processFabFilesServer] Truncated vectorized chunk for "${file.fileName}" to fit token budget (${maxChars}) from ${result.content.length} to ${content.length}`
              );
              break;
            }
            truncatedResults.push(result);
            totalChars += contentLength;
          }

          if (truncatedResults.length > 0) {
            userMessages.push({
              role: 'user',
              content: `Data for ${file.fileName}:\n${truncatedResults.map(r => `For context: ${r.content}`).join('\n')}`,
            });
          }
        } else {
          try {
            logger.info(
              `[processFabFilesServer] File "${file.fileName}" is NOT vectorized — using raw content path (maxTokens=${maxTokens})`
            );
            let errorMsg = null;

            let fabContent = fileContentCache.get(file.id);
            if (!fabContent) {
              fabContent = await getFileContent(file, {
                storage,
                logger,
              });
              fileContentCache.set(file.id, fabContent);
            }

            const maxSizeBasedonMaxTokens = maxTokens * CHARS_PER_TOKEN;
            const finalMaxFileSize = maxTokens > 0 ? maxSizeBasedonMaxTokens : MAX_FILE_SIZE;

            logger.log(`[processFabFilesServer] Final max file size: ${finalMaxFileSize}`);

            sendStatusUpdate('Adding file content to prompt...');
            if (fabContent.length > finalMaxFileSize) {
              await sendStatusUpdate('File is too large, truncating...');
              const originalFileSize = fabContent.length;
              fabContent = fabContent.substring(0, finalMaxFileSize ?? PREVIEW_CHUNK);
              errorMsg = `Knowledge in the workbench with the fileName ${file.fileName} is ${originalFileSize} long which exceeds ${finalMaxFileSize}. Vectorize your large file or select a model with higher context window.`;
              errorMessages.push({
                role: 'error',
                content: errorMsg,
              });
            } else {
              // clear error message if the file fits
              errorMsg = null;
            }

            if (file.system) {
              systemContent += fabContent;
            } else {
              // Collect file content to combine later instead of creating individual messages
              contextFiles.push({
                fileName: file.fileName,
                content: fabContent,
              });
            }

            await db.fabfiles.update({ id: file.id, error: errorMsg });
          } catch (e) {
            // Don't throw an error for unsupported file types
            if (e instanceof BadRequestError && e.message.includes('Unsupported file type')) {
              logger.warn(`Unsupported file type: ${file.fileName}`);
            } else if (isAxiosError(e) && e.response?.status === 404) {
              await sendStatusUpdate(`Skipping file ${file.fileName}. File might be corrupted or deleted`);
              await db.fabfiles.update({
                id: file.id,
                error:
                  'This file appears to be corrupted or may have been deleted. Please try uploading the file again.',
              });
            } else if (e instanceof CorruptedFileError) {
              await sendStatusUpdate(`Skipping corrupted file ${file.fileName}. Please try re-uploading`);
              await db.fabfiles.update({
                id: file.id,
                error: e.message,
              });
            } else {
              logger.updateMetadata({ filePath: file.filePath });
              throw e;
            }
          }
        }
      }
    } catch (error) {
      logger.updateMetadata({ fileId: file.id });
      logger.error(`🕐 [processFabFilesServer] Error processing file ${file.fileName}: ${error}`);
      throw error;
    }
  };

  // Process all chunks in parallel with progress tracking
  await Promise.all(
    chunks.map(chunk =>
      Promise.all(
        chunk.map(async file => {
          await processFileInParallel(file);
          processedFiles++;
          if (progressCallback) {
            await progressCallback(processedFiles, totalFiles);
          }
        })
      )
    )
  );

  if (imageContent.length > 0) {
    userMessages.push({
      role: 'user',
      content: imageContent,
    });
  }

  // Combine all context files into a single message.
  if (contextFiles.length > 0) {
    let combinedContent = '';

    if (contextFiles.length === 1) {
      // Single file: simple format
      combinedContent = `Here is the content from the attached file "${contextFiles[0].fileName}" for context:\n\n${contextFiles[0].content}`;
    } else {
      // Multiple files: structured format with clear separation
      combinedContent = `Here are the contents from ${contextFiles.length} attached files for context:\n\n`;
      contextFiles.forEach((file, index) => {
        combinedContent += `--- File ${index + 1}: ${file.fileName} ---\n${file.content}\n\n`;
      });
      combinedContent += `--- End of attached files ---`;
    }

    userMessages.push({
      role: 'user',
      content: combinedContent,
    });
  }

  if (systemContent) {
    userMessages.push({
      role: 'system',
      content: systemContent.trim(),
    });
  }
  const fileProcessingTime = Date.now() - fileProcessingStartTime;
  logger.info(`📁 File processing completed in ${fileProcessingTime}ms for ${fabFiles.length} files`);
  return { userMessages, errorMessages };
}

export function includeHardcodedSystemMessage(messages: IMessage[], formatPrompt: string): IMessage[] {
  let format = `format replies to maintain the integrity of the requested style. Default to markdown for text-based responses. Ensure proper structuring for poems, songs, or haikus with appropriate line breaks and stanza divisions. Adhere to specific formatting requests such as TypeScript when specified by the user.`;
  if (formatPrompt) {
    format = formatPrompt;
  }

  const hardcodedSystemMessage: IMessage = {
    role: 'system',
    content: format,
  };

  return [hardcodedSystemMessage, ...messages];
}

export function includeImagePromptSystemMessage(messages: IMessage[], userPrompt: string): IMessage[] {
  const imageRelatedVerbs = [
    'image',
    'illustration',
    'photo',
    'watercolor',
    'painting',
    'comic book',
    'picture',
    'diagram',
    'snapshot',
    'visual',
    'graphic',
  ];
  const hasImageRequest = imageRelatedVerbs.some(verb => userPrompt.toLowerCase().includes(verb));

  const content = `When the user requests an image, you MUST use the image_generation tool to create it. Craft a vivid and imaginative prompt parameter for the tool based on the user's request and available context.`;

  if (hasImageRequest) {
    const imageSystemMessage: IMessage = {
      role: 'system',
      content: content,
    };

    return [imageSystemMessage, ...messages];
  } else {
    return messages;
  }
}

export function includeArtifactSystemMessage(messages: IMessage[], userPrompt: string): IMessage[] {
  const artifactTriggerKeywords = [
    'component',
    'react',
    'todo',
    'calculator',
    'dashboard',
    'interface',
    'interactive',
    'widget',
    'app',
    'application',
    'develop',
    'code',
    'program',
    'script',
    'html',
    'javascript',
    'jsx',
    'tsx',
    'demo',
    'prototype',
    'showcase',
    // Long-form / shareable content requests: the model tends to emit a full HTML
    // document for these, so steer it to wrap that in a text/html artifact instead of
    // returning raw markup that renders as a wall of source in the chat.
    'article',
    'blog',
    'essay',
    'newsletter',
    'web page',
    'webpage',
    'landing page',
    'poster',
    'brochure',
    'flyer',
    'infographic',
  ];

  const hasArtifactRequest = artifactTriggerKeywords.some(keyword =>
    userPrompt.toLowerCase().includes(keyword.toLowerCase())
  );

  if (hasArtifactRequest) {
    const artifactSystemMessage: IMessage = {
      role: 'system',
      content: `When creating interactive content like React components, HTML pages, or SVG graphics, use Claude-style artifact syntax to make them displayable and executable:

For React components, wrap your code like this:
<artifact identifier="unique-id" type="application/vnd.ant.react" title="Component Title">
// Your React component code here
import React, { useState } from 'react';

function MyComponent() {
  // Component logic
  return (
    <div>
      // JSX content
    </div>
  );
}

export default MyComponent;
</artifact>

For HTML pages:
<artifact identifier="unique-id" type="text/html" title="Page Title">
<!DOCTYPE html>
<html>
<head>
  <title>Title</title>
  <style>
    /* CSS styles */
  </style>
</head>
<body>
  <!-- HTML content -->
  <script>
    // JavaScript code
  </script>
</body>
</html>
</artifact>

For SVG graphics:
<artifact identifier="unique-id" type="image/svg+xml" title="SVG Title">
<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
  <!-- SVG content -->
</svg>
</artifact>

Rules:
1. Use descriptive, kebab-case identifiers
2. Keep components self-contained with no external dependencies except React hooks
3. For React: Only use core React hooks (useState, useEffect, useMemo, useCallback)
4. Use Tailwind CSS classes only (no custom CSS or arbitrary values)
5. Make components functional and interactive
6. Always export default for React components
7. Provide clear, descriptive titles

This artifact syntax makes your creations immediately executable and previewable for users.`,
    };

    return [artifactSystemMessage, ...messages];
  }

  return messages;
}

// Priority order for message retention (lower number = higher priority)
const MESSAGE_PRIORITY = {
  system: 0, // Keep all system prompts
  user: 1, // Prioritize user messages
  assistant: 2, // Assistant responses lower priority
  tool: 3, // Tool results as needed
} as const;

// Last resort: truncate message content to a token limit. Prefer dropping complete messages.
const truncateMessageContent = (message: IMessage, tokenLimit: number): IMessage => {
  let content: MessageContent = message.content || '';

  const contentText = Array.isArray(content) ? content.map(obj => JSON.stringify(obj)).join('') : (content as string);
  const estimatedTokens = estimateTokenLength(contentText);

  if (estimatedTokens > tokenLimit) {
    const ratio = (0.9 * tokenLimit) / estimatedTokens;

    if (Array.isArray(content)) {
      const truncatedLength = Math.floor(content.length * ratio);
      content = content.slice(0, truncatedLength);
    } else {
      const truncatedLength = Math.floor((content as string).length * ratio);
      content = (content as string).slice(0, truncatedLength);
    }
  }
  return { ...message, content };
};

// Process messages, keeping complete ones over truncation to avoid mid-content cuts that cause
// hallucinations.
const processMessages = (
  messages: IMessage[],
  tokenBudget: number
): {
  messages: IMessage[];
  removedMessages: Array<{ role: string; tokens: number; priority: number }>;
} => {
  if (tokenBudget <= 0) {
    return { messages: [], removedMessages: [] };
  }

  const messagesWithTokens = messages.map((message, index) => {
    const contentText = Array.isArray(message.content)
      ? message.content.map(obj => JSON.stringify(obj)).join('')
      : (message.content as string);
    const tokens = estimateTokenLength(contentText);
    const priority = MESSAGE_PRIORITY[message.role as keyof typeof MESSAGE_PRIORITY] ?? 999;
    return { message, tokens, priority, originalIndex: index };
  });

  // Protect the last N user+assistant exchange pairs from being dropped.
  // These represent the most recent conversation context and are critical for coherence.
  const PROTECTED_RECENT_PAIRS = 3;
  const protectedMessages = new Set<number>();
  let pairsFound = 0;
  for (let i = messagesWithTokens.length - 1; i >= 0 && pairsFound < PROTECTED_RECENT_PAIRS; i--) {
    const role = messagesWithTokens[i].message.role;
    if (role === 'user' || role === 'assistant') {
      protectedMessages.add(i);
      // Count a pair when we find a user message (user comes before assistant in history)
      if (role === 'user') pairsFound++;
    }
  }

  // Pre-reserve protected messages and deduct their tokens from the budget
  const reservedMessages: typeof messagesWithTokens = [];
  let reservedTokens = 0;
  for (const idx of protectedMessages) {
    reservedMessages.push(messagesWithTokens[idx]);
    reservedTokens += messagesWithTokens[idx].tokens;
  }

  const unreservedMessages = messagesWithTokens.filter((_, idx) => !protectedMessages.has(idx));

  // Sort by priority (keep high priority messages)
  // Within same priority, prefer newer messages (higher originalIndex) so oldest get dropped first
  const sortedMessages = [...unreservedMessages].sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority; // Lower priority number = higher importance
    }
    return b.originalIndex - a.originalIndex; // Same priority: newer first
  });

  // Greedily add complete messages until we hit budget
  const selectedMessages: typeof messagesWithTokens = [...reservedMessages];
  let usedTokens = reservedTokens;

  for (const item of sortedMessages) {
    if (usedTokens + item.tokens <= tokenBudget) {
      selectedMessages.push(item);
      usedTokens += item.tokens;
    }
  }

  const selectedSet = new Set(selectedMessages);
  const removedMessages = messagesWithTokens
    .filter(item => !selectedSet.has(item))
    .map(item => ({
      role: item.message.role,
      tokens: item.tokens,
      priority: item.priority,
    }));

  // If we couldn't fit any messages but have budget, fall back to truncation
  if (selectedMessages.length === 0 && messages.length > 0) {
    const tokensPerMessage = Math.floor(tokenBudget / messages.length);
    return {
      messages: messages.map(message => truncateMessageContent(message, tokensPerMessage)),
      removedMessages: [],
    };
  }

  // Restore original chronological order
  selectedMessages.sort((a, b) => a.originalIndex - b.originalIndex);

  return {
    messages: selectedMessages.map(item => item.message),
    removedMessages,
  };
};

/**
 * Context debug info return type.
 */
export interface ContextDebugInfo {
  contextWindowUsage: {
    contextLimit: number;
    maxOutputTokens: number;
    safeMaxInputTokens: number;
    actualInputTokens: number;
    bufferTokens: number;
    utilizationPercentage: number;
    overflowDetected?: boolean;
    overflowAmount?: number;
  };
  messageTruncation: {
    wasTruncated: boolean;
    originalMessageCount: number;
    truncatedMessageCount: number;
    truncationMethod?: 'priority' | 'token-budget' | 'history-limit';
    removedMessages?: Array<{
      role: string;
      tokens: number;
      priority: number;
    }>;
  };
}

export async function buildAndSortMessages(
  previousMessages: IMessage[],
  fabMessages: IMessage[],
  userPrompt: IMessage[],
  maxInputTokens: number,
  settings: Record<string, string>,
  historyCount: number = 0,
  logger: Logger,
  tokenizer: ITokenizer,
  options: { verbose: boolean } = { verbose: false }
): Promise<IMessage[]> {
  if (maxInputTokens <= 0) {
    logger.error(`Invalid maxInputTokens: ${maxInputTokens}. Must be greater than 0.`);
    return [];
  }

  const VERBOSE_CHAT_CONTEXT = process.env.VERBOSE_CHAT_CONTEXT !== 'false';

  if (VERBOSE_CHAT_CONTEXT) {
    if (options.verbose) {
      logger.log('\n=== 🤖 Chat Completion Context ===');
      logger.log('📝 User Prompt:', userPrompt.map(m => m.content).join('\n'));
      logger.log('\n📚 Context Summary:');
      logger.log(`• History Messages: ${previousMessages.length}`);
      logger.log(`• Knowledge Files: ${fabMessages.filter(m => m.role === 'user').length}`);
      logger.log(`• System Messages: ${fabMessages.filter(m => m.role === 'system').length}`);
      logger.log(`• Max Input Tokens: ${maxInputTokens}`);
    }

    if (options.verbose) {
      logger.log('\n📊 Message Stats:');
      logger.log(`• History Count Setting: ${historyCount}`);
      logger.log(`• Previous Messages: ${previousMessages.length}`);
      logger.log(`• Knowledge Messages: ${fabMessages.length}`);
      logger.log(`• User Prompts: ${userPrompt.length}`);
    }

    const tokenBudget = maxInputTokens - 100; // buffer of 100
    if (options.verbose) {
      logger.log('\n💰 Token Budget:');
      logger.log(`• Available: ${tokenBudget.toLocaleString()}`);

      logger.log('\n=====================================\n');
    }
  }

  let tokenBudget: number = maxInputTokens;
  // Token buffer; see MIN_TOKEN_BUFFER and TOKEN_BUFFER_PERCENTAGE for rationale.
  const bufferTokenBudget: number = Math.max(MIN_TOKEN_BUFFER, Math.floor(maxInputTokens * TOKEN_BUFFER_PERCENTAGE));
  tokenBudget = tokenBudget - bufferTokenBudget;

  let userPromptContent: string = '';
  let userPromptTokens: number[] = [];

  if (userPrompt.length > 0) {
    userPromptContent = Array.isArray(userPrompt[0].content)
      ? JSON.stringify(userPrompt[0].content)
      : userPrompt[0].content || '';
    userPromptTokens = await tokenizer.encodeTokens(userPromptContent);
    tokenBudget = tokenBudget - userPromptTokens.length;
  }
  const systemMessages: IMessage[] = [];
  let systemTokenCount: number = 0;

  if (getSettingsValue('UseFormatPrompt', settings)) {
    const formatPromptTemplate = settings.FormatPromptTemplate;
    fabMessages = includeHardcodedSystemMessage(fabMessages, formatPromptTemplate);
  }

  if (getSettingsValue('UseImagePrompt', settings)) {
    fabMessages = includeImagePromptSystemMessage(fabMessages, userPromptContent);
  }

  if (getSettingsValue('EnableArtifacts', settings)) {
    fabMessages = includeArtifactSystemMessage(fabMessages, userPromptContent);
  }

  for (const message of fabMessages.filter(message => message.role === 'system')) {
    const content = (message.content as string) || '';
    const estimatedTokens = estimateTokenLength(content);
    if (systemTokenCount + estimatedTokens <= tokenBudget) {
      systemTokenCount += estimatedTokens;
      systemMessages.push(message);
    } else {
      break;
    }
  }

  tokenBudget -= systemTokenCount;

  const nonImageMessages: IMessage[] = fabMessages.filter(
    message => message.role === 'user' && !Array.isArray(message.content)
  );

  // TODO: also weight previousMessages by cosine score (not just fabMessages) - blocked on not
  // having vectors for previousMessages yet.
  const historyMessages =
    historyCount !== INFINITE_VALUE ? previousMessages.slice(-historyCount * 2) : previousMessages;
  const totalContentTokens = await calculateTotalTokenLength(nonImageMessages, { estimateOnly: true, tokenizer });
  const totalPreviousTokens = await calculateTotalTokenLength(historyMessages, { estimateOnly: true, tokenizer });
  let processedContentMessages: IMessage[] = [];
  let processedPreviousMessages: IMessage[] = [];

  // Track removed messages for truncation visibility
  const allRemovedMessages: Array<{ role: string; tokens: number; priority: number }> = [];
  const originalTotalMessageCount = historyMessages.length + nonImageMessages.length;

  // If historyCount is explicitly set (not INFINITE_VALUE), allocate tokens accordingly.
  if (historyCount !== INFINITE_VALUE) {
    // If the history fits within the budget, process it and allocate remaining tokens to content
    if (totalPreviousTokens <= tokenBudget) {
      const historyResult = processMessages(historyMessages, totalPreviousTokens);
      processedPreviousMessages = historyResult.messages;
      allRemovedMessages.push(...historyResult.removedMessages);
      tokenBudget -= totalPreviousTokens;

      const contentResult = processMessages(nonImageMessages, tokenBudget);
      processedContentMessages = contentResult.messages;
      allRemovedMessages.push(...contentResult.removedMessages);
    } else {
      // If the history itself exceeds the budget, then we need to truncate and prioritize history
      const historyResult = processMessages(historyMessages, tokenBudget);
      processedPreviousMessages = historyResult.messages;
      allRemovedMessages.push(...historyResult.removedMessages);
      processedContentMessages = []; // No tokens left for contentMessages
      // Mark all content messages as removed
      allRemovedMessages.push(
        ...nonImageMessages.map(msg => ({
          role: msg.role,
          tokens: estimateTokenLength(
            Array.isArray(msg.content) ? msg.content.map(obj => JSON.stringify(obj)).join('') : (msg.content as string)
          ),
          priority: MESSAGE_PRIORITY[msg.role as keyof typeof MESSAGE_PRIORITY] ?? 999,
        }))
      );
      logger.log(`History exceeds token budget. Truncating history to ${processedPreviousMessages.length} messages.`);
    }
  } else {
    // Check if both fit within the remaining token budget
    if (totalContentTokens + totalPreviousTokens <= tokenBudget) {
      const contentResult = processMessages(nonImageMessages, tokenBudget);
      processedContentMessages = contentResult.messages;
      allRemovedMessages.push(...contentResult.removedMessages);

      const historyResult = processMessages(historyMessages, tokenBudget);
      processedPreviousMessages = historyResult.messages;
      allRemovedMessages.push(...historyResult.removedMessages);
    } else {
      // Both exceed the budget: trim proportionally. See KNOWLEDGE_FILE_TOKEN_ALLOCATION for the split.
      const nonImageTokenBudget = Math.min(tokenBudget * KNOWLEDGE_FILE_TOKEN_ALLOCATION, totalContentTokens);
      const previousMessageTokenBudget = tokenBudget - nonImageTokenBudget;

      const contentResult = processMessages(nonImageMessages, nonImageTokenBudget);
      processedContentMessages = contentResult.messages;
      allRemovedMessages.push(...contentResult.removedMessages);

      const historyResult = processMessages(historyMessages, previousMessageTokenBudget);
      processedPreviousMessages = historyResult.messages;
      allRemovedMessages.push(...historyResult.removedMessages);
    }
  }

  // Separate image and non-image messages
  const imageMessages: IMessage[] = fabMessages.filter(
    message =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some(obj => obj.type.startsWith('image'))
  );

  // Combine all messages and sort with system messages at the top

  // Check if the last message in history is a tool_use
  const lastHistoryMessage = processedPreviousMessages[processedPreviousMessages.length - 1];
  const historyEndsWithToolUse =
    lastHistoryMessage?.role === 'assistant' &&
    Array.isArray(lastHistoryMessage.content) &&
    lastHistoryMessage.content.some((block: any) => block.type === 'tool_use');

  // Check if the user prompt contains a tool_result
  const promptHasToolResult = userPrompt.some(
    msg =>
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.some((block: any) => block.type === 'tool_result')
  );

  let messages: IMessage[];

  // tool_use blocks must be immediately followed by tool_result blocks. If history ends with a
  // tool_use and the userPrompt carries the tool_result, keep them adjacent by moving other
  // context (files/images) after the userPrompt.
  if (historyEndsWithToolUse && promptHasToolResult) {
    messages = [
      ...systemMessages, // System messages go first for instruction
      ...processedPreviousMessages, // previous message context
      ...userPrompt, // Tool result must follow tool use immediately
      ...imageMessages, // Include all image messages
      ...processedContentMessages, // fab file content (non-image messages)
    ];
  } else {
    messages = [
      ...systemMessages, // System messages go first for instruction
      ...processedPreviousMessages, // previous message context
      ...imageMessages, // Include all image messages
      ...processedContentMessages, // fab file content (non-image messages)
      ...userPrompt, // Spread the userPrompt array into the messages array
    ];
  }

  // Final safety check - validate that messages don't exceed the safe token limit
  // Use actual tokenizer here for accurate count (not estimates) to prevent overflow
  const finalTokenCount = await calculateTotalTokenLength(messages, { estimateOnly: false, tokenizer });
  if (finalTokenCount > maxInputTokens) {
    logger.warn(
      `⚠️ Final message token count (${finalTokenCount}) exceeds maxInputTokens (${maxInputTokens}). Truncating messages.`
    );
    // If we still exceed limits, remove some processed content messages as last resort
    const excessTokens = finalTokenCount - maxInputTokens;
    const reducedContentMessagesResult = processMessages(
      processedContentMessages,
      Math.max(
        0,
        (await calculateTotalTokenLength(processedContentMessages, { estimateOnly: false, tokenizer })) - excessTokens
      )
    );

    let truncatedMessages: IMessage[];
    if (historyEndsWithToolUse && promptHasToolResult) {
      truncatedMessages = [
        ...systemMessages,
        ...processedPreviousMessages,
        ...userPrompt,
        ...imageMessages,
        ...reducedContentMessagesResult.messages,
      ];
    } else {
      truncatedMessages = [
        ...systemMessages,
        ...processedPreviousMessages,
        ...imageMessages,
        ...reducedContentMessagesResult.messages,
        ...userPrompt,
      ];
    }
    // Ensure tool_use/tool_result pairing integrity after truncation
    return ensureToolPairingIntegrity(truncatedMessages, logger);
  }

  const VERBOSE_MESSAGE_BUILDING = process.env.VERBOSE_MESSAGE_BUILDING === 'true';

  if (VERBOSE_MESSAGE_BUILDING) {
    logger.log('=== Verbose Message Building Log ===');
    if (processedPreviousMessages.length < historyMessages.length) {
      logger.log(
        `Truncated ${historyMessages.length - processedPreviousMessages.length} previous messages due to token budget`
      );
    }

    logger.log('\nFinal Combined Messages:');
    messages.forEach((msg, i) => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      logger.log(`  ${i + 1}. Role: ${msg.role}, Content: ${content.substring(0, 50)}...`);
    });

    logger.log(`\nTotal messages: ${messages.length}`);
    logger.log('=== End of Verbose Message Building Log ===');
  }

  // Store debug info for external access
  const truncationMethod: 'priority' | 'token-budget' | 'history-limit' | undefined =
    historyCount !== INFINITE_VALUE ? 'history-limit' : allRemovedMessages.length > 0 ? 'token-budget' : undefined;

  (buildAndSortMessages as any).lastDebugInfo = {
    messageTruncation: {
      wasTruncated: allRemovedMessages.length > 0,
      originalMessageCount: originalTotalMessageCount,
      truncatedMessageCount: processedPreviousMessages.length + processedContentMessages.length,
      truncationMethod,
      removedMessages: allRemovedMessages.length > 0 ? allRemovedMessages : undefined,
    },
  };

  // Ensure tool_use/tool_result pairing integrity after any truncation
  return ensureToolPairingIntegrity(messages, logger);
}

/**
 * Returns the debug info populated by the most recent buildAndSortMessages call.
 */
export function getLastBuildDebugInfo(): ContextDebugInfo['messageTruncation'] | null {
  return (buildAndSortMessages as any).lastDebugInfo?.messageTruncation || null;
}
