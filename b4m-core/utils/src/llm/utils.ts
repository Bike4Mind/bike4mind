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
/**
 * Chunks per attached file that cosine retrieval feeds to the model. Three starved small embedders: a
 * chunk is the embedding model's context window less a 20% buffer (see SmartChunker), so three chunks
 * is roughly 69k chars on an 8192-token embedder but only 4.3k on a 512-token one, which answers a
 * question about a 200-row table from 43 rows without saying so.
 *
 * 10 is borrowed from rankChunksForFiles' topK default, but note the two caps differ in shape: that
 * one is global across every file in the search, this one is PER FILE, so a multi-file attachment can
 * yield more chunks here. What bounds the payload is the per-file character budget applied to these
 * results (maxChars in processFabFilesServer), not this count - though that budget is derived from
 * the model's OUTPUT token limit, which is its own separate defect.
 */
const COSINE_SEARCH_TOP_K = 10;

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
 * Applies only when historyCount is INFINITE_VALUE; a finite historyCount uses the floor below.
 */
const KNOWLEDGE_FILE_TOKEN_ALLOCATION = 0.7;

/**
 * Smallest share of the token budget an explicitly attached file is guaranteed when a finite
 * historyCount is set. History used to have absolute priority here, so a long conversation silently
 * pushed the file the user just attached out of context entirely and the model answered as though no
 * file existed.
 *
 * 0.35 is the largest share that still leaves history the clear majority, which the user did not ask
 * to give up, while sitting at or above the per-file budget attachments effectively got already on
 * every model class of 8k context and up - so it raises the floor without cutting what a file
 * receives today. A fraction rather than a token count, so the reserve can never exceed the budget on
 * a small context window. The exact figure is not load-bearing: unused reserve flows back to history,
 * so over-reserving costs nothing and this only binds when content genuinely wants more.
 */
const MIN_ATTACHED_CONTENT_TOKEN_ALLOCATION = 0.35;

/**
 * Rounds the final safety pass may spend shrinking the payload. It has to re-measure between rounds
 * (see the pass for why one shot overshoots), and each round costs a real tokenizer call, so this
 * bounds the work. Converges in one or two rounds in practice.
 */
const MAX_SAFETY_SHRINK_ROUNDS = 5;

/**
 * Appended to attached-file content that had to be cut to fit. Without it a CSV sliced mid-row reads
 * as a complete file: the model treats the last surviving row as the final row and answers about it
 * confidently, which is indistinguishable from a correct answer unless you already hold the file.
 * Counted against the budget like any other content, because it is really sent.
 */
const CONTENT_TRUNCATION_NOTICE =
  '\n\n[Content truncated to fit the context window. This is NOT the end of the file - later content was not sent.]';

const estimateTokenLength = (text: string): number => {
  // Rough estimate: ~3.5 chars per token for English text
  return Math.ceil(text.length / CHARS_PER_TOKEN);
};

/**
 * Flattens a message's content to the text the estimators measure. Note this deliberately omits the
 * role, unlike calculateTotalTokenLength which concatenates role + content and charges a flat rate
 * per image. The two are therefore NOT interchangeable, which matters most for the squeeze check in
 * buildAndSortMessages: comparing what content used against what it wanted has to use this estimator
 * on both sides, or the role overhead alone would report every attachment as squeezed.
 */
const messageContentText = (message: IMessage): string =>
  Array.isArray(message.content)
    ? message.content.map(obj => JSON.stringify(obj)).join('')
    : ((message.content as string) ?? '');

const estimateMessageTokens = (message: IMessage): number => estimateTokenLength(messageContentText(message));

const estimateMessagesTokens = (messages: IMessage[]): number =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

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
  // Vectors of different dimensions cannot be compared: this happens when the
  // Default Embedding Model changes and old chunks were embedded at another
  // dimension (e.g. switching between Ollama nomic-embed-text at 768 and OpenAI
  // at 1536). Score 0 keeps the mismatch out of results instead of returning NaN.
  if (vector1.length !== vector2.length) return 0;
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

  return searchResults.sort((a: any, b: any) => b.score - a.score).slice(0, COSINE_SEARCH_TOP_K);
}

/**
 * Downscales an image to fit the model's dimension limit. Injected into
 * processFabFilesServer (see its deps) rather than imported here so this module -
 * and thus the @bike4mind/utils barrel - carries no jimp dependency. Server callers
 * pass `ensureImageWithinDimensionLimit` from '@bike4mind/utils/imageResize'. See #660.
 */
type ResizeImageForModel = (imageBuffer: Buffer, maxDimension?: number, logger?: Logger) => Promise<Buffer>;

/** Passthrough default: no resize when a caller doesn't inject one. */
const noopResize: ResizeImageForModel = async imageBuffer => imageBuffer;

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
    // Injected (see ResizeImageForModel) so this module carries no jimp dependency.
    // Defaults to a passthrough when omitted. #660
    resizeImageForModel = noopResize,
  }: {
    logger: Logger;
    storage: BaseStorage;
    db: {
      fabfilechunks: Pick<IFabFileChunkRepository, 'findByFabFileId'>;
      fabfiles: Pick<IFabFileRepository, 'update'>;
      caches: ICacheRepository;
    };
    resizeImageForModel?: ResizeImageForModel;
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
              const imageBuffer = await resizeImageForModel(rawImageBuffer, undefined, logger);
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

          case ModelBackend.Ollama: {
            // Vision-capable local models take the image inline. We build the same
            // Anthropic-style base64 block the Anthropic path uses; the Ollama
            // backend later maps it into Ollama's images[] field. Enforce the
            // dimension cap so a large upload does not blow the local context.
            const rawImageBuffer = await storage.download(file.filePath!);
            const imageBuffer = await resizeImageForModel(rawImageBuffer, undefined, logger);
            const { mime: ollamaMimeType } = await getFileType(imageBuffer, file.fileName, file.mimeType);
            const ollamaBase64 = imageBuffer.toString('base64');

            // Soft byte guard paralleling the Anthropic/Gemini path above: even after
            // the dimension cap, a heavy image inflates the prompt and can overflow a
            // small local model's context window. Warn (do not drop) so the operator
            // can shrink the upload if the model then misbehaves.
            const OLLAMA_IMAGE_WARN_MB = 3.5;
            const ollamaImageSizeMB = imageBuffer.byteLength / (1024 * 1024);
            if (ollamaImageSizeMB > OLLAMA_IMAGE_WARN_MB) {
              const warnMsg = `Image "${file.fileName}" (${ollamaImageSizeMB.toFixed(1)}MB) is large for a local model and may exceed its context window.`;
              logger.warn(`[processFabFilesServer] ${warnMsg}`);
              await sendStatusUpdate(warnMsg);
            }

            imageContent.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: ollamaMimeType,
                data: ollamaBase64,
              },
            });
            // Add filename and fabFileId as text context to prevent hallucinated filenames.
            imageContent.push({
              type: 'text',
              text: `Image URL: ${fileUrl}\nFile: "${file.fileName}" (fabFileId: ${file.id})\nWhen referencing this file, use the exact filename "${file.fileName}". Do not rename based on image content.`,
            });
            break;
          }

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

  const estimatedTokens = estimateTokenLength(messageContentText(message));

  if (estimatedTokens > tokenLimit) {
    const ratio = (0.9 * tokenLimit) / estimatedTokens;

    if (Array.isArray(content)) {
      // Array content truncates by whole blocks, so keep at least one: flooring to zero yields an
      // empty content array, which providers reject. A single oversized block cannot be shrunk this
      // way at all - the caller's budget check is what catches that.
      const truncatedLength = Math.max(1, Math.floor(content.length * ratio));
      content = content.slice(0, truncatedLength);
    } else {
      const truncatedLength = Math.floor((content as string).length * ratio);
      content = (content as string).slice(0, truncatedLength);
    }
  }
  return { ...message, content };
};

// Process messages, keeping complete ones over truncation to avoid mid-content cuts that cause
// hallucinations. Never returns more than `tokenBudget` worth of messages, except in the truncation
// fallback at the bottom: that stays under 90% of the budget, plus the truncation notice when one is
// passed - which on a very small budget can put the total over it. The caller's final safety pass
// absorbs that.
const processMessages = (
  messages: IMessage[],
  tokenBudget: number,
  // Appended to any message this call actually shortens. Passed only for attached-file content: it is
  // applied at the truncation site because that is the only place that KNOWS a message was cut.
  // Inferring it afterwards by comparing against the originals cannot distinguish a cut file from a
  // whole one whose bytes happen to match a sibling attachment, in either direction.
  { truncationNotice }: { truncationNotice?: string } = {}
): {
  messages: IMessage[];
  removedMessages: Array<{ role: string; tokens: number; priority: number }>;
} => {
  const describeRemoved = (message: IMessage) => ({
    role: message.role,
    tokens: estimateMessageTokens(message),
    priority: MESSAGE_PRIORITY[message.role as keyof typeof MESSAGE_PRIORITY] ?? 999,
  });

  // Negated rather than `tokenBudget <= 0` so NaN lands here too: every `x > NaN` comparison below is
  // false, so a NaN budget would otherwise reserve everything and silently defeat the whole cap.
  if (!(tokenBudget > 0)) {
    // Only messages that carry content count as a loss. An empty-content message is not a truncation
    // event, and reporting it as one would flip truncationMethod to 'token-budget' on a healthy turn.
    return { messages: [], removedMessages: messages.filter(m => estimateMessageTokens(m) > 0).map(describeRemoved) };
  }

  const messagesWithTokens = messages.map((message, index) => ({
    message,
    tokens: estimateMessageTokens(message),
    priority: MESSAGE_PRIORITY[message.role as keyof typeof MESSAGE_PRIORITY] ?? 999,
    originalIndex: index,
  }));

  // The last N user+assistant exchange pairs are the most recent conversation context and matter
  // most for coherence, so they get first claim on the budget - but only as far as it stretches
  // (see the reservation below). Collected newest-first so the oldest lose out first.
  const PROTECTED_RECENT_PAIRS = 3;
  const protectedIndices: number[] = [];
  let pairsFound = 0;
  for (let i = messagesWithTokens.length - 1; i >= 0 && pairsFound < PROTECTED_RECENT_PAIRS; i--) {
    const role = messagesWithTokens[i].message.role;
    if (role === 'user' || role === 'assistant') {
      protectedIndices.push(i);
      // Count a pair when we find a user message (user comes before assistant in history)
      if (role === 'user') pairsFound++;
    }
  }

  // Reserve protected messages only while they fit, so the reservation can never overshoot the
  // budget. `continue` rather than `break`: one oversized recent message must not block the
  // smaller ones behind it.
  const reservedIndices = new Set<number>();
  const reservedMessages: typeof messagesWithTokens = [];
  let reservedTokens = 0;
  for (const idx of protectedIndices) {
    const item = messagesWithTokens[idx];
    if (reservedTokens + item.tokens > tokenBudget) continue;
    reservedIndices.add(idx);
    reservedMessages.push(item);
    reservedTokens += item.tokens;
  }

  // Keyed on what was actually reserved, so a protected message that missed out rejoins the
  // candidate pool below instead of becoming unselectable.
  const unreservedMessages = messagesWithTokens.filter((_, idx) => !reservedIndices.has(idx));

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
    // Under 1 token each, truncation yields empty content that providers reject, so drop the
    // messages instead and let the removal reporting below stand.
    if (tokensPerMessage >= 1) {
      return {
        messages: messages.map(message => {
          const truncated = truncateMessageContent(message, tokensPerMessage);
          // Every message reaching this branch gets shortened - it only runs when none of them fit,
          // and the per-message share is at most the budget each one already exceeded. The type check
          // is the real guard: array content truncates by whole blocks and takes no text notice.
          if (!truncationNotice || typeof truncated.content !== 'string') return truncated;
          return { ...truncated, content: truncated.content + truncationNotice };
        }),
        // Under-reports on purpose: content was cut mid-message but no message was dropped.
        // Reporting these as removed would make truncationRate read 0% next to a truncation flag,
        // so callers surface mid-message loss through their own warn instead.
        removedMessages: [],
      };
    }
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

  // Artifact guidance comes from the admin-editable `ArtifactEmissionPrompt` system message that the
  // caller injects (see ChatCompletionProcess). A legacy hardcoded artifact prompt used to be injected
  // here too and CONFLICTED with it - it demonstrated `import React, { useState }`, mandated "Tailwind
  // CSS classes only", and said nothing about publishing - so the model followed it and produced
  // non-publishable artifacts. It has been removed so ArtifactEmissionPrompt is the single source of truth.

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
  // The historyCount > 0 guard matters: slice(-0) is slice(0), which returns the WHOLE array, so
  // asking for no history used to send all of it. Image models set historyCount to 0 precisely to
  // keep history out of their small context windows.
  const historyMessages =
    historyCount === INFINITE_VALUE
      ? previousMessages
      : historyCount > 0
        ? previousMessages.slice(-historyCount * 2)
        : [];
  const totalContentTokens = await calculateTotalTokenLength(nonImageMessages, { estimateOnly: true, tokenizer });
  const totalPreviousTokens = await calculateTotalTokenLength(historyMessages, { estimateOnly: true, tokenizer });
  let processedContentMessages: IMessage[] = [];
  let processedPreviousMessages: IMessage[] = [];

  // Track removed messages for truncation visibility. `contentSqueezed` covers the loss that
  // `allRemovedMessages` structurally cannot: content cut mid-message rather than dropped.
  const allRemovedMessages: Array<{ role: string; tokens: number; priority: number }> = [];
  let contentSqueezed = false;
  const originalTotalMessageCount = historyMessages.length + nonImageMessages.length;

  // If historyCount is explicitly set (not INFINITE_VALUE), allocate tokens accordingly.
  if (historyCount !== INFINITE_VALUE) {
    // Content gets whatever history does not need, but never less than the floor. Both the fits and
    // the overflow case run through this one expression: splitting them would put a cliff on the
    // `totalPreviousTokens <= tokenBudget` boundary, where one more token of history flipped content
    // between everything and nothing. Over-reserving here is harmless because history is sized from
    // what content actually consumed, not from this figure.
    const attachedContentTokens = estimateMessagesTokens(nonImageMessages);
    const contentBudget =
      tokenBudget <= 0
        ? 0
        : Math.max(Math.floor(tokenBudget * MIN_ATTACHED_CONTENT_TOKEN_ALLOCATION), tokenBudget - totalPreviousTokens);

    // Content first: history's budget depends on what content actually used.
    const contentResult = processMessages(nonImageMessages, contentBudget, {
      truncationNotice: CONTENT_TRUNCATION_NOTICE,
    });
    processedContentMessages = contentResult.messages;
    allRemovedMessages.push(...contentResult.removedMessages);

    // Unused reserve flows back, so a small attachment costs history nothing.
    const contentTokensUsed = estimateMessagesTokens(processedContentMessages);
    contentSqueezed = contentTokensUsed < attachedContentTokens;

    const historyResult = processMessages(historyMessages, tokenBudget - contentTokensUsed);
    processedPreviousMessages = historyResult.messages;
    allRemovedMessages.push(...historyResult.removedMessages);

    if (contentSqueezed) {
      // Warned rather than logged because the symptom is a missing answer, not an error: the model
      // says it cannot see the file and the user has no way to tell why. Compared estimate against
      // estimate, so an attachment that fully fits can never trip this.
      logger.warn(
        `Attached content squeezed to fit the token budget: kept ${processedContentMessages.length}/${nonImageMessages.length} message(s), ` +
          `${contentTokensUsed}/${attachedContentTokens} est. tokens (reserved ${contentBudget} of ${tokenBudget}, floor ` +
          `${Math.round(MIN_ATTACHED_CONTENT_TOKEN_ALLOCATION * 100)}%). Affected: ` +
          nonImageMessages.map(msg => messageContentText(msg).split('\n')[0].slice(0, 120)).join(' | ')
      );
    }
    if (totalPreviousTokens > tokenBudget) {
      logger.log(`History exceeds token budget. Truncating history to ${processedPreviousMessages.length} messages.`);
    }
  } else {
    // Check if both fit within the remaining token budget
    if (totalContentTokens + totalPreviousTokens <= tokenBudget) {
      const contentResult = processMessages(nonImageMessages, tokenBudget, {
        truncationNotice: CONTENT_TRUNCATION_NOTICE,
      });
      processedContentMessages = contentResult.messages;
      allRemovedMessages.push(...contentResult.removedMessages);

      const historyResult = processMessages(historyMessages, tokenBudget);
      processedPreviousMessages = historyResult.messages;
      allRemovedMessages.push(...historyResult.removedMessages);
    } else {
      // Both exceed the budget: trim proportionally. See KNOWLEDGE_FILE_TOKEN_ALLOCATION for the split.
      const nonImageTokenBudget = Math.min(tokenBudget * KNOWLEDGE_FILE_TOKEN_ALLOCATION, totalContentTokens);
      const previousMessageTokenBudget = tokenBudget - nonImageTokenBudget;

      const contentResult = processMessages(nonImageMessages, nonImageTokenBudget, {
        truncationNotice: CONTENT_TRUNCATION_NOTICE,
      });
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

  // Budget loss outranks history windowing: reporting 'history-limit' whenever historyCount was
  // finite - which is nearly always - made a file the budget had silently zeroed look identical in
  // telemetry to history being windowed exactly as configured, which is why that bug went unnoticed
  // for so long. `contentSqueezed` is needed alongside allRemovedMessages because content cut
  // mid-message is a budget loss that drops no message and so leaves allRemovedMessages empty.
  // Called on BOTH return paths: the overflow path below returns early, so assigning this only at
  // the end left the worst-loss turn reporting the previous call's numbers from a warm container.
  const recordDebugInfo = (finalContentMessages: IMessage[]) => {
    const historyWindowed = previousMessages.length > historyMessages.length;
    const budgetTruncated = allRemovedMessages.length > 0 || contentSqueezed;
    (buildAndSortMessages as any).lastDebugInfo = {
      messageTruncation: {
        wasTruncated: budgetTruncated,
        originalMessageCount: originalTotalMessageCount,
        truncatedMessageCount: processedPreviousMessages.length + finalContentMessages.length,
        truncationMethod: budgetTruncated ? 'token-budget' : historyWindowed ? 'history-limit' : undefined,
        removedMessages: allRemovedMessages.length > 0 ? allRemovedMessages : undefined,
      },
    };
  };

  // Final safety check - validate that messages don't exceed the safe token limit
  // Use actual tokenizer here for accurate count (not estimates) to prevent overflow
  const finalTokenCount = await calculateTotalTokenLength(messages, { estimateOnly: false, tokenizer });
  if (finalTokenCount > maxInputTokens) {
    logger.warn(
      `⚠️ Final message token count (${finalTokenCount}) exceeds maxInputTokens (${maxInputTokens}). Truncating messages.`
    );
    // Shrink content first, then history, recomputing the real count each round until it fits. Three
    // things stopped this pass from doing its job. processMessages ignored its own budget (content
    // messages are all role 'user' and there are usually only 1-3 of them, so every one counted as
    // "recent" and the oversized set came back untouched). It only ever touched content, yet the
    // overflow usually lives in history, which holds the majority of the budget. And it never
    // re-measured, while processMessages selects on the character estimate and this budget is in real
    // tokenizer units - so a single pass overshoots on anything that tokenizes denser than ~3.5
    // chars/token (code, CSV, CJK). Each of those left the excess to reach the caller's hard throw,
    // making the backstop the cause of the failure it exists to prevent.
    let reducedContentMessages = processedContentMessages;
    let currentTokenCount = finalTokenCount;
    // Rebuilt up to twice per round so the real-token count is measured against the actual payload.
    // Cheap at five rounds, but it is the place to extend if another source ever has to give up
    // tokens here - images are the obvious candidate, since they are assembled in without ever
    // being charged against the budget.
    const assemble = (content: IMessage[]) =>
      historyEndsWithToolUse && promptHasToolResult
        ? [...systemMessages, ...processedPreviousMessages, ...userPrompt, ...imageMessages, ...content]
        : [...systemMessages, ...processedPreviousMessages, ...imageMessages, ...content, ...userPrompt];

    // Content is asked to give first, but a round that frees nothing has to move on to history rather
    // than retrying forever: processMessages is judging against the character estimate, so content
    // that is oversized in real tokens can still look like it fits and come back untouched.
    let contentExhausted = reducedContentMessages.length === 0;
    for (let round = 0; round < MAX_SAFETY_SHRINK_ROUNDS && currentTokenCount > maxInputTokens; round++) {
      // processMessages budgets in estimate tokens while the overage was measured by the real
      // tokenizer, so convert before spending it and keep each round's arithmetic in one unit.
      // Convergence is guaranteed by the loop and the no-progress check, not by this scaling.
      const estimatedTotal = estimateMessagesTokens(assemble(reducedContentMessages));
      const realPerEstimate = estimatedTotal > 0 ? currentTokenCount / estimatedTotal : 1;
      const excessInEstimateTokens = Math.ceil((currentTokenCount - maxInputTokens) / realPerEstimate);

      if (!contentExhausted) {
        const before = reducedContentMessages;
        const budgetBasis = estimateMessagesTokens(before);
        const reduced = processMessages(before, Math.max(0, budgetBasis - excessInEstimateTokens), {
          truncationNotice: CONTENT_TRUNCATION_NOTICE,
        });
        reducedContentMessages = reduced.messages;
        // Reported like the history branch below. These are messages the pass dropped on top of
        // whatever the primary allocation already removed, so they cannot be double-counted: this
        // round only ever sees the content that survived to here.
        allRemovedMessages.push(...reduced.removedMessages);
        if (reduced.messages.length < before.length) {
          logger.warn(
            `Final safety pass dropped ${before.length - reduced.messages.length} of ${before.length} ` +
              `attached content message(s) to fit the context window.`
          );
        }
      } else if (processedPreviousMessages.length > 0) {
        const before = processedPreviousMessages;
        const reduced = processMessages(before, Math.max(0, estimateMessagesTokens(before) - excessInEstimateTokens));
        if (reduced.messages.length === before.length) break; // history cannot shrink further either
        logger.warn(
          `Final safety pass also dropped ${before.length - reduced.messages.length} of ${before.length} ` +
            `history message(s): the attached content alone could not absorb the overflow.`
        );
        processedPreviousMessages = reduced.messages;
        allRemovedMessages.push(...reduced.removedMessages);
      } else {
        // Only system messages and the user prompt remain, and neither is droppable here.
        break;
      }

      const afterTokenCount = await calculateTotalTokenLength(assemble(reducedContentMessages), {
        estimateOnly: false,
        tokenizer,
      });
      if (afterTokenCount >= currentTokenCount && !contentExhausted) contentExhausted = true;
      currentTokenCount = afterTokenCount;
    }

    if (currentTokenCount > maxInputTokens) {
      logger.warn(
        `Final safety pass could not bring the payload under maxInputTokens (${currentTokenCount} > ${maxInputTokens}); ` +
          `system messages and the user prompt alone exceed the window.`
      );
    }

    let truncatedMessages: IMessage[];
    if (historyEndsWithToolUse && promptHasToolResult) {
      truncatedMessages = [
        ...systemMessages,
        ...processedPreviousMessages,
        ...userPrompt,
        ...imageMessages,
        ...reducedContentMessages,
      ];
    } else {
      truncatedMessages = [
        ...systemMessages,
        ...processedPreviousMessages,
        ...imageMessages,
        ...reducedContentMessages,
        ...userPrompt,
      ];
    }
    recordDebugInfo(reducedContentMessages);
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

  recordDebugInfo(processedContentMessages);

  // Ensure tool_use/tool_result pairing integrity after any truncation
  return ensureToolPairingIntegrity(messages, logger);
}

/**
 * Returns the debug info populated by the most recent buildAndSortMessages call.
 */
export function getLastBuildDebugInfo(): ContextDebugInfo['messageTruncation'] | null {
  return (buildAndSortMessages as any).lastDebugInfo?.messageTruncation || null;
}
