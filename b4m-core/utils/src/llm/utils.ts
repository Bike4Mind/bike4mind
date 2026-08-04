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
  isAudioMimeType,
  isImageAttachment,
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
  isUnlimitedHistory,
  resolveHistoryFetchLimit,
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
 * Applies only when history is unlimited; a windowed historyCount uses the floor below.
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
 * (see the pass for why one shot overshoots), and each round costs two real tokenizer calls, so this
 * bounds the work. Converges in one or two rounds in practice.
 */
const MAX_SAFETY_SHRINK_ROUNDS = 5;

/**
 * Appended to attached-file content that had to be cut to fit. Without it a CSV sliced mid-row reads
 * as a complete file: the model treats the last surviving row as the final row and answers about it
 * confidently, which is indistinguishable from a correct answer unless you already hold the file.
 * Counted against the budget like any other content, because it is really sent. This text is for the
 * model only - what later steps read to know a message was cut is processMessages' truncatedMessages.
 */
const CONTENT_TRUNCATION_NOTICE =
  '\n\n[Content truncated to fit the context window. This is NOT the end of the file - later content was not sent.]';

/**
 * Below this many tokens of a file, a slice is not worth sending. A few dozen characters of a CSV does
 * not read as a truncated file - it reads as no file, and the model says so confidently, which is the
 * silent wrong answer this whole area exists to prevent. Replacing the slice with a plain statement is
 * both smaller and honest.
 */
const MIN_USEFUL_ATTACHED_CONTENT_TOKENS = 200;

/**
 * Content is cut in three places, and only the assembly cut is this file's own budget arithmetic.
 * Extraction head-slices a file that exceeds its per-file budget, and vectorized retrieval hands back
 * the top-scoring chunks rather than the document. Both used to arrive at assembly looking complete,
 * so nothing marked them and the model described a fragment as the whole file - the same silent
 * retrieval failure this module exists to prevent, one stage earlier.
 *
 * Separate wordings because the shapes differ and saying the wrong one is its own defect: a head slice
 * really does stop partway, whereas excerpts are non-contiguous, so "later content was not sent" would
 * invite exactly the wrong inference about what is missing.
 */
const EXCERPT_NOTICE_PREFIX = '\n\n[The above are the most relevant excerpts from ';

const EXCERPT_NOTICE_TAIL =
  `, selected by similarity. They are in file ` +
  `order but are NOT the whole file and NOT contiguous - parts between them were not sent, and content after ` +
  `the last excerpt may exist. Do not describe this as the complete file, and do not infer a total row or ` +
  `section count, or a final row, from it.]`;

/**
 * Filenames are user-controlled and get interpolated into the app's own bracketed directive, so a
 * crafted name could close the bracket and append instructions to the one signal that stops the model
 * claiming it holds a complete file. Brackets, quotes and newlines go, and the length is bounded so
 * the assembled notice stays within the span upstreamNoticeIn will recognise.
 */
const MAX_NOTICE_FILENAME_CHARS = 100;
const sanitizeNoticeFileName = (fileName: string): string =>
  fileName
    .replace(/[[\]"\r\n]/g, ' ')
    .trim()
    .slice(0, MAX_NOTICE_FILENAME_CHARS);

const excerptNotice = (fileName: string): string =>
  `${EXCERPT_NOTICE_PREFIX}"${sanitizeNoticeFileName(fileName)}"${EXCERPT_NOTICE_TAIL}`;

const URL_TRUNCATION_NOTICE =
  '\n\n[Fetched page content truncated to fit the context window. This is NOT the end of the page - later ' +
  'content was not sent.]';

/**
 * The notice an upstream stage already attached, if any. Assembly's own cut slices the tail off and
 * would append the generic head-slice wording in its place - which is FALSE for excerpts: it would
 * tell the model the content simply stops here, the very inference the excerpt notice exists to block.
 * Every claim in an upstream notice survives a further cut, so the right move is to put the same one
 * back rather than overwrite it.
 *
 * Matched by prefix because the excerpt notice carries a filename. A file whose own text ends with
 * this sentence would be misread, but the only consequence is which true-either-way notice is
 * appended, so an exact-match guard is not worth the code.
 *
 * The content notice is recognised for the same reason, though no visible fragment of it is
 * reachable today: extraction appends it before assembly ever sees the message, so assembly can
 * re-cut an already-annotated message, but `truncateMessageContent` keeps at most 0.9 of the length
 * and a fragment long enough to read as a notice needs more than that. Holding it out makes the
 * invariant structural instead of a consequence of that 0.9.
 */
const externalNoticeIn = (text: string): string | null => {
  if (text.endsWith(URL_TRUNCATION_NOTICE)) return URL_TRUNCATION_NOTICE;
  if (!text.endsWith(EXCERPT_NOTICE_TAIL)) return null;
  const start = text.lastIndexOf(EXCERPT_NOTICE_PREFIX);
  if (start === -1) return null;
  const span = text.slice(start);
  // Bounded to prefix + a quoted, length-capped filename + the constant tail. A longer span means the
  // prefix matched inside the content itself - a pasted transcript of a previous answer, or a crafted
  // file - and holding that out of the cut would exempt most of the payload from truncation.
  const maxSpan = EXCERPT_NOTICE_PREFIX.length + MAX_NOTICE_FILENAME_CHARS + 2 + EXCERPT_NOTICE_TAIL.length;
  return span.length <= maxSpan ? span : null;
};

const upstreamNoticeIn = (text: string): string | null =>
  text.endsWith(CONTENT_TRUNCATION_NOTICE) ? CONTENT_TRUNCATION_NOTICE : externalNoticeIn(text);

/**
 * Messages built from a URL in the prompt rather than from an attached file. They reach assembly in
 * the same block as file content, so without this they get counted as attachments and the undelivered
 * note tells the model a file could not be included when no file was lost - or when none was attached
 * at all. Keyed by identity for the same reason cutContentMessages is: content cannot spoof it, and
 * the caller spreads these objects through without cloning them.
 */
const urlDerivedMessages = new WeakSet<IMessage>();

/**
 * Flat per-image token charge. Exact cost needs decoding the image (Anthropic ~ width*height/750;
 * OpenAI varies by detail level, low=85), so both the estimator and the real counter assume ~1600
 * ("normal"). They must use the same figure or converting an overage between the two units skews.
 */
const IMAGE_TOKEN_ESTIMATE = 1600;

/** Bounded so building a log label never walks a multi-MB attachment. */
const ATTACHMENT_LABEL_SCAN_CHARS = 400;

/**
 * The attachment headers that carry a filename, anchored to a line start. Must stay in sync with the
 * message builders in processFabFilesServer: the single-file header, the multi-file `--- File N:`
 * blocks, and a vectorized file's `Data for` header. Anything else - notably URL-derived content,
 * which opens with the fetched page body - has no name to read and is labelled positionally.
 */
const ATTACHMENT_NAME_HEADERS = [
  /^Here is the content from the attached file "(.{1,120})" for context:$/gm,
  /^--- File \d+: (.{1,120}) ---$/gm,
  /^Data for (.{1,120}):$/gm,
];

const estimateTokenLength = (text: string): number => {
  // Rough estimate: ~3.5 chars per token for English text
  return Math.ceil(text.length / CHARS_PER_TOKEN);
};

const isImageBlock = (obj: { type?: string }): boolean => obj.type === 'image' || obj.type === 'image_url';

/**
 * Flattens a message's content to its text, skipping image blocks - their base64 payload is not text
 * and stringifying it would both mis-measure the message and put megabytes of data into any log line
 * built from this. Images are charged separately by estimateMessageTokens.
 *
 * Differs from calculateTotalTokenLength only in omitting the role string, so the two are still NOT
 * interchangeable: the squeeze check in buildAndSortMessages has to use this estimator on both sides
 * or the role overhead alone would report every attachment as squeezed.
 */
const messageContentText = (message: IMessage): string =>
  Array.isArray(message.content)
    ? message.content
        .filter(obj => !isImageBlock(obj))
        .map(obj => JSON.stringify(obj))
        .join('')
    : ((message.content as string) ?? '');

/**
 * Must charge images the same flat rate as calculateTotalTokenLength, so the two measures stay
 * comparable: stringifying base64 as text here would make an image-carrying turn read as millions of
 * tokens against a real count that charges a flat rate. The final safety pass divides one measure by the
 * other to convert its overage between them, so an image-carrying turn depends on these rates matching.
 */
const estimateMessageTokens = (message: IMessage): number => {
  const imageCount = Array.isArray(message.content) ? message.content.filter(isImageBlock).length : 0;
  return estimateTokenLength(messageContentText(message)) + imageCount * IMAGE_TOKEN_ESTIMATE;
};

const estimateMessagesTokens = (messages: IMessage[]): number =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

/**
 * Rough per-quest token size, used only to choose the verbatim-window boundary
 * (which older turns to fold into contextSummary). Deliberately an estimate, not
 * the exact tokenizer: buildAndSortMessages still enforces the real budget with
 * the tokenizer downstream, so this only needs to be directionally right while
 * staying synchronous (no N async tokenizer calls over a long history). Mirrors
 * the fields the conversion below actually emits into the prompt.
 */
function estimateQuestTokenLength(item: {
  prompt?: string;
  replies?: string[];
  structuredReplies?: unknown[];
  toolResults?: unknown[];
  promptMeta?: { functionCalls?: RecordedFunctionCall[] };
}): number {
  const parts: string[] = [item.prompt ?? ''];
  if (item.structuredReplies?.length) {
    parts.push(JSON.stringify(item.structuredReplies));
  } else if (item.replies?.length) {
    parts.push(item.replies.join('\n'));
  }
  if (item.toolResults?.length) {
    parts.push(JSON.stringify(item.toolResults));
  }
  // Priority 2 replays these as tool_use/tool_result blocks, and the serialized parameters can
  // dwarf the text reply. Only counted when it will actually be taken (structuredReplies wins).
  if (!item.structuredReplies?.length) {
    const toolCalls = replayableToolCalls(item.promptMeta?.functionCalls);
    if (toolCalls.length) parts.push(JSON.stringify(toolCalls));
  }
  return estimateTokenLength(parts.join('\n'));
}

/** Stands in for a tool_result whose returnValue was never recorded; must not be empty. */
export const TOOL_RESULT_NOT_RECORDED = '[tool result not recorded]';

type RecordedFunctionCall = {
  id?: string;
  name?: string;
  parameters?: unknown;
  returnValue?: string;
  success?: boolean;
};

/** A recorded call complete enough to replay as a tool_use/tool_result pair. */
type ReplayableToolCall = RecordedFunctionCall & { id: string; name: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The recorded tool calls that can be replayed into Anthropic-valid message blocks, or an empty
 * list if this turn should fall back to its plain text reply instead.
 *
 * Both filters are load-bearing. An entry missing an id or name cannot form a valid pair, and
 * repeated ids are rejected outright, so those are dropped rather than emitted. Beyond that the
 * turn is only worth replaying if SOME call recorded a returnValue - see the call site for why
 * replaying result-less calls is worse than not replaying at all.
 */
function replayableToolCalls(functionCalls: RecordedFunctionCall[] | undefined): ReplayableToolCall[] {
  if (!functionCalls?.length) return [];

  const seenIds = new Set<string>();
  const replayable = functionCalls.filter((fc): fc is ReplayableToolCall => {
    if (!fc.id || !fc.name || seenIds.has(fc.id)) return false;
    seenIds.add(fc.id);
    return true;
  });

  return replayable.some(fc => fc.returnValue) ? replayable : [];
}

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
 *
 * `historyCount` is a window in quests: null means the default page size, 0 or below means no
 * history at all, and UNLIMITED_HISTORY_COUNT means no window (which still pages, since the
 * fetch needs some limit).
 */
export async function fetchAndProcessPreviousMessages(
  session: ISessionDocument,
  historyCount: number | null = null,
  {
    db,
    verbatimTokenBudget,
  }: {
    db: {
      quests: Pick<IChatHistoryItemRepository, 'getMostRecentChatHistory'>;
    };
    /**
     * When set, keep only the newest turns whose estimated size fits this many
     * tokens verbatim; older turns are excluded from the window (and reported via
     * excludedOlderQuestCount) so ContextSummarizationFeature can fold them into
     * contextSummary. Omit to keep the legacy count-only behavior.
     */
    verbatimTokenBudget?: number;
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
      /** Older turns dropped from the verbatim window by verbatimTokenBudget (0 when none). */
      excludedOlderQuestCount?: number;
      /** Recently generated images (bare storage keys + originating prompt), newest first. */
      recentGeneratedImages?: { key: string; prompt: string }[];
    },
  ]
> {
  // Unlimited is negative, so it has to be recognised before the no-history check below.
  if (!isUnlimitedHistory(historyCount) && historyCount !== null && historyCount <= 0) {
    return [[], 0, { cacheHit: false }];
  }

  const limit = resolveHistoryFetchLimit(historyCount);

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

  // Token-bound the verbatim window: keep the newest turns whose cumulative
  // estimated size fits verbatimTokenBudget and drop the older ones, so they fall
  // outside the window and can be folded into contextSummary. The most recent turn
  // is always kept even if it alone exceeds the budget. This is what lets a heavy
  // session with FEW messages still compact (the count window alone would keep
  // everything and leave nothing to summarize). buildAndSortMessages still applies
  // the exact-tokenizer budget downstream; this only chooses the summary boundary.
  let excludedOlderQuestCount = 0;
  if (verbatimTokenBudget && verbatimTokenBudget > 0 && chatHistoryItems.length > 1) {
    let usedTokens = 0;
    let keepFromIndex = 0;
    for (let i = chatHistoryItems.length - 1; i >= 0; i--) {
      usedTokens += estimateQuestTokenLength(chatHistoryItems[i]);
      // Never drop the most recent turn (i === length-1), even if oversized.
      if (usedTokens > verbatimTokenBudget && i < chatHistoryItems.length - 1) {
        keepFromIndex = i + 1;
        break;
      }
    }
    if (keepFromIndex > 0) {
      excludedOlderQuestCount = keepFromIndex;
      chatHistoryItems.splice(0, keepFromIndex);
    }
  }

  const oldestIncludedQuestId = chatHistoryItems[0]?.id ?? null;

  // Convert to IMessage format with tool pairing reconstruction.
  const convertedMessages = chatHistoryItems.reduce((acc, cur) => {
    if (cur.prompt) acc.push({ role: 'user', content: cur.prompt });

    const toolCalls = replayableToolCalls(cur.promptMeta?.functionCalls);

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
    // Priority 2: reconstruct tool_use/tool_result pairs from promptMeta.functionCalls when
    // structuredReplies is absent (older turns, and any writer that does not populate it).
    //
    // Requires at least one recorded returnValue. A call with an id but no result carries no
    // information the model can use, and replaying it would cost the turn its real text reply:
    // this branch and Priority 3 are mutually exclusive, so entering here on result-less calls
    // replaces a genuine answer with a list of tool invocations and empty outcomes.
    else if (toolCalls.length > 0) {
      // Get text reply (excluding thinking blocks)
      const textReply = cur.replies?.find((reply: string) => !reply.trim().startsWith('<think>')) || '';

      // Build assistant message with text + tool_use blocks
      const assistantContent: MessageContentObject[] = [];

      if (textReply) {
        assistantContent.push({ type: 'text', text: textReply } as MessageContentText);
      }

      for (const fc of toolCalls) {
        assistantContent.push({
          type: 'tool_use',
          id: fc.id,
          name: fc.name,
          // Anthropic requires an object here; parameters is Mixed, so a scalar can reach us.
          input: isPlainObject(fc.parameters) ? fc.parameters : {},
        } as MessageContentToolUse);
      }

      acc.push({ role: 'assistant', content: assistantContent });

      // One tool_result per tool_use, same order, ids 1:1 - Anthropic rejects an unpaired block.
      // returnValue is not always recorded, so fall back to a marker rather than an empty
      // string, which the API rejects outright.
      acc.push({
        role: 'user',
        content: toolCalls.map(fc => ({
          type: 'tool_result' as const,
          tool_use_id: fc.id,
          content: fc.returnValue || (fc.success === false ? 'Tool execution failed' : TOOL_RESULT_NOT_RECORDED),
          is_error: fc.success === false,
        })),
      });
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
      excludedOlderQuestCount,
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
        if (isImageBlock(obj)) {
          // Both Anthropic ('image') and OpenAI ('image_url'). CRITICAL: without this branch, base64
          // image data would be JSON.stringify'd and counted as text, causing massive overflow (e.g.
          // 2.7M tokens). estimateMessageTokens charges the same rate for the same reason.
          imageTokenCount += IMAGE_TOKEN_ESTIMATE;
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

      const urlContentTruncated = textContent.length > maxContentBuffer!;
      if (urlContentTruncated) {
        logger.warn(
          `[processUrlsFromPrompt] Truncated fetched content for ${sanitizeUrlForLogging(url)} from ` +
            `${textContent.length} to ${maxContentBuffer} chars to fit the context window.`
        );
      }
      const message: IMessage = {
        role: 'user',
        content:
          `For context: ${textContent.substring(0, maxContentBuffer!)}` +
          (urlContentTruncated ? URL_TRUNCATION_NOTICE : ''),
      };
      urlDerivedMessages.add(message);
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
): Promise<{ results: Array<{ chunkId: string; content: string; score: number }>; totalChunks: number }> {
  const chunks = await db.fabfilechunks.findByFabFileId(file.id);

  const searchResults = chunks
    .map((chunk: any, position: number) => {
      const score = computeCosineSimilarity(userPromptVector, chunk.vector!);
      return { chunkId: chunk.id, content: chunk.text, score, position };
    })
    .filter((result: any) => result !== null);

  // Similarity decides WHICH chunks; document order decides how they are PRESENTED. Returning them in
  // score order handed the model a scrambled file - even when every chunk was delivered - which is one
  // of the ways it ends up naming a mid-file row as the last. `position` is the repository's order,
  // which is ascending _id, i.e. the order the chunks were written.
  //
  // totalChunks lets the caller tell the model when it is holding a subset. Without it the top-K slice
  // is indistinguishable from "this is the whole file".
  const selected = [...searchResults].sort((a: any, b: any) => b.score - a.score).slice(0, COSINE_SEARCH_TOP_K);
  return {
    results: selected.sort((a, b) => a.position - b.position).map(({ position, ...rest }) => rest),
    totalChunks: searchResults.length,
  };
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
  /**
   * Total tokens of attached-file content this turn may contribute, derived from the
   * model's INPUT window. Was previously the output-token cap, which bore no relation
   * to how much of a file could be read. Split across the text files below.
   */
  attachedContentTokenBudget: number,
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

  // Embedding the query powers semantic chunk selection over vectorized files, but it is an
  // OPTIMIZATION, not a prerequisite for answering. A failure here - provider down, key revoked or
  // scoped out of the embeddings endpoint, rate limited - must not abort the whole turn: without
  // this guard a single 401 surfaced as "OpenAI rejected the embedding request" and no file reached
  // the model at all. On failure we leave userVectorPrompt empty and every file falls through to the
  // raw-content path below, so the attachment still reaches the model.
  try {
    userVectorPrompt[selectedEmbeddingModel] = await generateSafeEmbedding(
      embeddingFactory.createEmbeddingService(selectedEmbeddingModel),
      userPrompt,
      logger
    );
  } catch (error) {
    logger.warn(
      `[processFabFilesServer] Query embedding failed (${selectedEmbeddingModel}); ` +
        'falling back to raw file content for this turn.',
      error
    );
  }

  const embeddingTime = Date.now() - embeddingStartTime;
  logger.info(`🕐 [processFabFilesServer] User prompt embedding completed in ${embeddingTime}ms`);

  // Cache for file content to avoid redundant processing
  // The char caps below are applied per file and never summed, so the budget has to be
  // divided up front or N files would each get the full allowance. Images are excluded:
  // they do not consume this text budget.
  const textFileCount = Math.max(1, fabFiles.filter(f => !isImageAttachment(f.mimeType)).length);
  // Guard the per-file share against 0: the char caps below read a non-positive budget
  // as "no budget supplied" and fall back to a flat MAX_FILE_SIZE per file, which at N
  // files is unbounded. A caller that genuinely has no room should send no files.
  const maxTokens = Math.max(1, Math.floor(attachedContentTokenBudget / textFileCount));

  const fileContentCache = new Map<string, string>();

  const processFileInParallel = async (file: IFabFileDocument): Promise<void> => {
    try {
      // Audio (generated TTS / sound effects) is never LLM input: no model
      // accepts audio, and the non-image branch below would otherwise try to
      // read the bytes as text. This is the authoritative attachment guard -
      // every chat/agent path funnels through here, so a file that slips past
      // the attach UI still can't reach the model.
      if (isAudioMimeType(file.mimeType)) {
        logger.warn(
          `[processFabFilesServer] Skipping audio file ${file.fileName} — audio is not attachable to an LLM.`
        );
        return;
      }

      if (supportsVision && isImageAttachment(file.mimeType)) {
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
          case ModelBackend.XAI:
          // Moonshot takes OpenAI's base64 `image_url` block verbatim. Grouped
          // here rather than given its own case because the payload is identical;
          // without it every Kimi model advertising supportsVision would accept
          // an attachment, drop it at `default`, and answer as if blind.
          case ModelBackend.Kimi: {
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
            } else if (modelInfo.id.startsWith('moonshot')) {
              // Bedrock-served Kimi speaks OpenAI on the Invoke path, so it takes
              // the base64 `image_url` block rather than the Anthropic `source`
              // block the branch above builds. Without this it would fall to the
              // warn below while still advertising supportsVision.
              const moonshotBuffer = await resizeImageForModel(
                await storage.download(file.filePath!),
                undefined,
                logger
              );
              const { mime: moonshotMimeType } = await getFileType(moonshotBuffer, file.fileName, file.mimeType);
              const moonshotBase64 = moonshotBuffer.toString('base64');

              // Bedrock caps the Invoke body around 3 MB. If even the resized image
              // still exceeds it, skip with the same friendly re-upload guidance the
              // Anthropic branch gives rather than letting Bedrock reject the whole
              // request with a raw ValidationException. Checked post-resize so we only
              // reject images that are genuinely too large.
              const MOONSHOT_MAX_BASE64_BYTES = 3_000_000;
              if (moonshotBase64.length > MOONSHOT_MAX_BASE64_BYTES) {
                const encodedMB = (moonshotBase64.length / (1024 * 1024)).toFixed(1);
                const errorMsg = `⚠️ Image "${file.fileName}" (${encodedMB}MB encoded) is too large for ${modelInfo.name}. Max ~3MB. Please delete this file and re-upload a smaller image.`;
                logger.warn(errorMsg);
                await sendStatusUpdate(errorMsg);
                errorMessages.push({ role: 'error', content: errorMsg });
                return;
              }

              imageContent.push({
                type: 'image_url',
                image_url: { url: `data:${moonshotMimeType};base64,${moonshotBase64}` },
              });
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
      } else if (!supportsVision && isImageAttachment(file.mimeType)) {
        logger.warn(`File ${file.fileName} is an image but model does not support vision. Skipping...`);
      } else {
        // Files without embeddingModel are old files that were vectorized with the default embedding
        // model, which is text-embedding-ada-002.
        const embeddingModel =
          (file.embeddingModel as SupportedEmbeddingModel) ?? OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002;
        const userVector = userVectorPrompt[embeddingModel];

        // Cosine chunk selection needs BOTH a vectorized file and a query vector in the same space.
        // A vectorized file with no usable query vector (the query embedding failed above, or the
        // file was stored under a different embedding model than this turn's default) must NOT be
        // dropped - fall through to the raw-content path so the attachment still reaches the model.
        const canCosineSearch = file.vectorized && !!userVector && userVector.length > 0;

        if (canCosineSearch) {
          // Perform cosine search for vectorized content
          sendStatusUpdate('Now doing retrieval augmented search');

          // clear error message if the file has been vectorized
          if (file.error?.startsWith('Knowledge in the workbench with the fileName')) {
            await db.fabfiles.update({ id: file.id, error: null });
          }

          const { results: searchResults, totalChunks } = await cosineSearch(file, userVector, { db, logger });

          // Truncate search results to fit within the token budget
          const maxChars = maxTokens > 0 ? maxTokens * CHARS_PER_TOKEN : MAX_FILE_SIZE;
          const truncatedResults: Array<{ chunkId: string; content: string; score: number }> = [];
          let totalChars = 0;
          let anyChunkCut = false;

          for (const result of searchResults) {
            const contentLength = result.content?.length ?? 0;
            if (totalChars + contentLength > maxChars && truncatedResults.length > 0) {
              break;
            }
            if (contentLength > maxChars - totalChars) {
              const content = result.content.substring(0, maxChars - totalChars);
              truncatedResults.push({ ...result, content });
              totalChars = maxChars;
              anyChunkCut = true;
              logger.warn(
                `[processFabFilesServer] Truncated vectorized chunk for "${file.fileName}" to fit token budget (${maxChars}) from ${result.content.length} to ${content.length}`
              );
              break;
            }
            truncatedResults.push(result);
            totalChars += contentLength;
          }

          if (truncatedResults.length > 0) {
            // Results arrive in file order, so every chunk with none cut is the whole file and needs
            // no notice. Every chunk WITH a cut is still contiguous, and the excerpt wording ("parts
            // between them were not sent") would misdescribe it - that is a head slice reached by
            // another route, so it takes the truncation wording. The loop only ever cuts a chunk when
            // the first one alone exceeds the budget (any later overflow breaks instead), so today
            // that means a single-chunk file; the condition is written on the invariant rather than
            // on the chunk count so it stays correct if the loop learns to cut a tail.
            const deliveredEveryChunk = totalChunks === truncatedResults.length;
            let notice = '';
            if (!deliveredEveryChunk) notice = excerptNotice(file.fileName);
            else if (anyChunkCut) notice = CONTENT_TRUNCATION_NOTICE;

            const body = `Data for ${file.fileName}:\n${truncatedResults.map(r => `For context: ${r.content}`).join('\n')}`;
            userMessages.push({ role: 'user', content: body + notice });

            if (notice) {
              logger.warn(
                `[processFabFilesServer] Delivered ${truncatedResults.length}/${totalChunks} chunk(s) of "${file.fileName}"` +
                  (deliveredEveryChunk
                    ? ', with the last cut to fit the character budget.'
                    : ' as similarity-ranked excerpts; the model is told not to read them as the whole file.')
              );
            }
          }
        } else {
          try {
            logger.info(
              `[processFabFilesServer] Using raw content path for "${file.fileName}" ` +
                `(vectorized=${!!file.vectorized}, haveQueryVector=${!!userVector}, maxTokens=${maxTokens})`
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
              // In band, at the site that knows: assembly cannot tell a head-sliced file from a whole one,
              // so without this the model presents the slice as the complete file and names a mid-file
              // row as the last.
              fabContent = fabContent.substring(0, finalMaxFileSize ?? PREVIEW_CHUNK) + CONTENT_TRUNCATION_NOTICE;
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
  // Scoped to formatting ONLY. The previous wording ("Adhere to specific formatting
  // requests...") read as a general compliance instruction and measurably degraded
  // refusal behavior on underspecified asks (#1320: 81.1 -> 40.3 as the sole system
  // content). Same failure shape as the artifact prompt's pre-SCOPE wording (#1296):
  // any instruction that sounds like "comply with requests" bleeds into WHETHER to
  // answer, not just how to format. Keep any future edit inside that boundary.
  let format = `Formatting only - nothing here decides whether or how fully to answer. Format replies to maintain the integrity of the requested style; default to markdown for text. Preserve proper structure for poems, songs, or haikus. When the user specifies an output format (e.g. TypeScript), use that format for the parts you do answer.`;
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
  // Appended to any message this call actually shortens. Passed only for attached-file content, and
  // applied here because this is the only place that knows a message was cut: inferring it afterwards
  // by comparing against the originals cannot distinguish a cut file from a whole one whose bytes
  // happen to match a sibling attachment, in either direction.
  { truncationNotice }: { truncationNotice?: string } = {}
): {
  messages: IMessage[];
  removedMessages: Array<{ role: string; tokens: number; priority: number }>;
  // The returned objects this call shortened. Identity is the only reliable signal a message was cut:
  // comparing bytes against the originals cannot tell a cut file from a whole one that happens to
  // match a sibling, and sniffing for the appended notice mistakes a file ending in that text for a
  // cut one. Callers surface mid-message loss from this, since removedMessages stays empty for it.
  truncatedMessages: IMessage[];
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
    return {
      messages: [],
      removedMessages: messages.filter(m => estimateMessageTokens(m) > 0).map(describeRemoved),
      truncatedMessages: [],
    };
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
      const truncatedMessages = messages.map(message => {
        // Held out of the slice so the cut cannot leave a fragment of it behind, then put back after.
        const upstream =
          truncationNotice && typeof message.content === 'string' ? upstreamNoticeIn(message.content) : null;
        const source = upstream
          ? { ...message, content: (message.content as string).slice(0, -upstream.length) }
          : message;
        const truncated = truncateMessageContent(source, tokensPerMessage);
        // Every message reaching this branch gets shortened - it only runs when none of them fit,
        // and the per-message share is at most the budget each one already exceeded. The type check
        // is the real guard: array content truncates by whole blocks and takes no text notice.
        if (!truncationNotice || typeof truncated.content !== 'string') return truncated;
        return { ...truncated, content: truncated.content + (upstream ?? truncationNotice) };
      });
      return {
        messages: truncatedMessages,
        // Under-reports on purpose: content was cut mid-message but no message was dropped.
        // Reporting these as removed would make truncationRate read 0% next to a truncation flag,
        // so callers surface mid-message loss through truncatedMessages instead.
        removedMessages: [],
        truncatedMessages,
      };
    }
  }

  // Restore original chronological order
  selectedMessages.sort((a, b) => a.originalIndex - b.originalIndex);

  return {
    messages: selectedMessages.map(item => item.message),
    removedMessages,
    truncatedMessages: [],
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
  options: {
    verbose: boolean;
    /**
     * Skip the admin-configured templates this function appends (FormatPromptTemplate, image
     * prompt). They are invisible from the caller's own system-message assembly, so a caller
     * asking for an unadorned completion cannot exclude them any other way.
     */
    skipAdminPromptTemplates?: boolean;
  } = { verbose: false }
): Promise<IMessage[]> {
  // Negated like processMessages' budget guard so a NaN lands here rather than sailing past every
  // comparison below.
  if (!(maxInputTokens > 0)) {
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

  if (!options.skipAdminPromptTemplates) {
    if (getSettingsValue('UseFormatPrompt', settings)) {
      const formatPromptTemplate = settings.FormatPromptTemplate;
      fabMessages = includeHardcodedSystemMessage(fabMessages, formatPromptTemplate);
    }

    if (getSettingsValue('UseImagePrompt', settings)) {
      fabMessages = includeImagePromptSystemMessage(fabMessages, userPromptContent);
    }
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
  const historyMessages = isUnlimitedHistory(historyCount)
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

  // Attached-content messages this run shortened, by identity. Every content allocation funnels
  // through recordContentResult so a cut made anywhere - either allocation branch or the final safety
  // pass - is reported, and so `contentSqueezed` reads the structural signal rather than comparing
  // token totals: the appended notice can leave a squeezed message measuring larger than the original.
  const cutContentMessages = new Set<IMessage>();
  // History cut mid-message is a budget loss too. Tracked apart from contentSqueezed so it feeds
  // truncationMethod without firing the attached-content warning, which is about the file only.
  let historyCutMidMessage = false;
  const recordHistoryResult = (result: ReturnType<typeof processMessages>): IMessage[] => {
    allRemovedMessages.push(...result.removedMessages);
    if (result.truncatedMessages.length > 0) historyCutMidMessage = true;
    return result.messages;
  };
  const recordContentResult = (result: ReturnType<typeof processMessages>): IMessage[] => {
    allRemovedMessages.push(...result.removedMessages);
    result.truncatedMessages.forEach(message => cutContentMessages.add(message));
    if (result.removedMessages.length > 0 || result.truncatedMessages.length > 0) contentSqueezed = true;
    return result.messages;
  };

  // Content-free descriptor for logs. Names are read only from the three headers that carry one
  // (see the message builders above), each anchored to a line start so a quoted or bracketed span
  // inside the file's own text cannot be mistaken for a header - a CSV field is quoted as often as
  // not. URL-derived content opens with the fetched page body and has no header at all, so it is
  // labelled positionally rather than by echoing what it contains.
  const attachmentLabel = (message: IMessage, index: number): string => {
    const head = messageContentText(message).slice(0, ATTACHMENT_LABEL_SCAN_CHARS);
    const named: string[] = [];
    for (const pattern of ATTACHMENT_NAME_HEADERS) {
      // Shared /g regexes carry lastIndex between calls, so reset before each scan.
      pattern.lastIndex = 0;
      for (let match = pattern.exec(head); match; match = pattern.exec(head)) named.push(`"${match[1]}"`);
    }
    return `${named.length ? named.join(', ') : `attachment ${index + 1}`} (~${estimateMessageTokens(message)} est. tokens)`;
  };

  // A windowed request allocates content a floor and gives history the rest; an unwindowed one splits
  // the budget (see KNOWLEDGE_FILE_TOKEN_ALLOCATION in the else branch).
  if (!isUnlimitedHistory(historyCount)) {
    // Content gets whatever history does not need, but never less than the floor. Both the fits and
    // the overflow case run through this one expression: splitting them would put a cliff on the
    // `totalPreviousTokens <= tokenBudget` boundary, where one more token of history flipped content
    // between everything and nothing. Over-reserving here is harmless because history is sized from
    // what content actually consumed, not from this figure.
    const attachedContentTokens = estimateMessagesTokens(nonImageMessages);
    // Negated like the guards at the two layers above, so NaN lands in the zero branch here too. A
    // NaN cannot currently reach this line, but the two idioms sitting side by side invited someone
    // to loosen the ones that are load-bearing.
    const contentBudget = !(tokenBudget > 0)
      ? 0
      : Math.max(Math.floor(tokenBudget * MIN_ATTACHED_CONTENT_TOKEN_ALLOCATION), tokenBudget - totalPreviousTokens);

    // Content first: history's budget depends on what content actually used.
    processedContentMessages = recordContentResult(
      processMessages(nonImageMessages, contentBudget, { truncationNotice: CONTENT_TRUNCATION_NOTICE })
    );

    // Unused reserve flows back, so a small attachment costs history nothing.
    const contentTokensUsed = estimateMessagesTokens(processedContentMessages);

    processedPreviousMessages = recordHistoryResult(processMessages(historyMessages, tokenBudget - contentTokensUsed));

    if (contentSqueezed) {
      // Warned rather than logged because the symptom is a missing answer, not an error: the model
      // says it cannot see the file and the user has no way to tell why.
      logger.warn(
        `Attached content squeezed to fit the token budget: kept ${processedContentMessages.length}/${nonImageMessages.length} message(s), ` +
          `${contentTokensUsed}/${attachedContentTokens} est. tokens (reserved ${contentBudget} of ${tokenBudget}, floor ` +
          `${Math.round(MIN_ATTACHED_CONTENT_TOKEN_ALLOCATION * 100)}%). Affected: ` +
          nonImageMessages.map(attachmentLabel).join(' | ')
      );
    }
    if (totalPreviousTokens > tokenBudget) {
      logger.log(`History exceeds token budget. Truncating history to ${processedPreviousMessages.length} messages.`);
    }
  } else {
    // Check if both fit within the remaining token budget
    if (totalContentTokens + totalPreviousTokens <= tokenBudget) {
      processedContentMessages = recordContentResult(
        processMessages(nonImageMessages, tokenBudget, { truncationNotice: CONTENT_TRUNCATION_NOTICE })
      );

      processedPreviousMessages = recordHistoryResult(processMessages(historyMessages, tokenBudget));
    } else {
      // Both exceed the budget: trim proportionally. See KNOWLEDGE_FILE_TOKEN_ALLOCATION for the split.
      const nonImageTokenBudget = Math.min(tokenBudget * KNOWLEDGE_FILE_TOKEN_ALLOCATION, totalContentTokens);
      const previousMessageTokenBudget = tokenBudget - nonImageTokenBudget;

      processedContentMessages = recordContentResult(
        processMessages(nonImageMessages, nonImageTokenBudget, { truncationNotice: CONTENT_TRUNCATION_NOTICE })
      );

      processedPreviousMessages = recordHistoryResult(processMessages(historyMessages, previousMessageTokenBudget));
    }
  }

  // A sliver of a file is worse than none: the model does not recognise it as file content and answers
  // as though nothing was attached. Judged per message rather than on the total, so two attachments
  // each cut to an unusable fragment are both caught - summing them hides exactly that case.
  //
  // Per message is not yet per file: processFabFilesServer combines all plain files into a single
  // message, so three CSVs sharing one message are judged, counted and reported as one. Vectorized
  // and URL content each get their own message and so are judged separately. Real per-file accounting
  // needs block-level bookkeeping through extraction and is tracked separately.
  const fileTokens = (message: IMessage): number => {
    const text = messageContentText(message);
    // No notice is the file's own content, and either kind pushes a sliver over the threshold - the
    // excerpt notice weighs ~101 estimate tokens by itself, half the usability floor. Ours is matched
    // by identity so a file whose text happens to end with that sentence cannot spoof a cut; an
    // upstream notice is structurally ours already, so recognising it by text is enough.
    const notice =
      cutContentMessages.has(message) && text.endsWith(CONTENT_TRUNCATION_NOTICE)
        ? CONTENT_TRUNCATION_NOTICE
        : externalNoticeIn(text);
    return estimateTokenLength(notice ? text.slice(0, -notice.length) : text);
  };
  // Attachments that carried no extractable text are excluded - losing nothing is not a loss, and
  // counting it would report a truncation on a completely healthy turn. URL-derived content is
  // excluded on the same grounds: it rides in this block but is not an attachment, and counting it
  // made the note claim a file was lost on turns where the file arrived whole, or where the prompt
  // carried only a link and no file existed at all.
  const isAttachment = (message: IMessage): boolean => !urlDerivedMessages.has(message) && fileTokens(message) > 0;
  const attachmentsWithContent = nonImageMessages.filter(isAttachment);
  let undeliveredNote: IMessage | null = null;

  // Only a change in what is undelivered is news: the safety pass calls the declaration once per shrink
  // round, so one turn would otherwise log up to five warnings disagreeing about the counts.
  let lastDeclaredCounts = '';

  /**
   * Replaces attachments that arrived too small to be recognised as file content, and declares any
   * dropped whole, with one message saying so. Called by both stages that shrink content: the
   * allocation below, and the final safety pass after it, which can drop an attachment the allocation
   * had delivered.
   *
   * Idempotent, which is what makes the per-round call safe: the note it produced last time is
   * excluded by identity, so it re-judges only real attachments and replaces that note rather than
   * stacking another. It keeps the note in the payload it measures, so the ~100 tokens it costs are
   * counted, not hidden.
   */
  const declareUndeliveredAttachments = (contentMessages: IMessage[]): IMessage[] => {
    if (attachmentsWithContent.length === 0) return contentMessages;

    // Read before the reassignment below, because identity is what retires the previous round's note.
    // Comparing against the new object leaves the old one in place, and a stale note passes isAttachment
    // and so counts as a delivered file - each round then declares one fewer loss than the last, while
    // the payload grows by another ~100-token duplicate of the same sentence.
    const previousNote = undeliveredNote;
    // Counted on the same footing as attachmentsWithContent - same isAttachment predicate on both sides.
    // An attachment carrying no extractable text, or a URL-derived message, is absent from both:
    // counting either as delivered let it stand in for a sibling that was dropped, and the drop then
    // went undeclared.
    const delivered = contentMessages.filter(message => message !== previousNote && isAttachment(message));
    // Computed once: fileTokens re-derives the message text, and the safety pass calls this per round.
    const replaced = new Set(
      delivered.filter(
        message => cutContentMessages.has(message) && fileTokens(message) < MIN_USEFUL_ATTACHED_CONTENT_TOKENS
      )
    );
    const droppedCount = Math.max(0, attachmentsWithContent.length - delivered.length);
    const sliverCount = replaced.size;
    if (droppedCount === 0 && sliverCount === 0) return contentMessages;

    const counts = `${droppedCount}/${sliverCount}`;
    if (counts !== lastDeclaredCounts) {
      lastDeclaredCounts = counts;
      logger.warn(
        `Attached content could not be delivered usefully: ${droppedCount} file(s) dropped whole and ` +
          `${sliverCount} reduced below the ${MIN_USEFUL_ATTACHED_CONTENT_TOKENS}-token minimum worth sending. ` +
          `Context window is too small after system instructions and history. Affected: ` +
          attachmentsWithContent.map(attachmentLabel).join(' | ')
      );
    }
    contentSqueezed = true;
    // Deliberately names no files. Which attachment was lost is not knowable here once processMessages
    // has replaced the objects, and listing all of them let the model disclaim one it did receive.
    undeliveredNote = {
      role: 'user',
      content:
        `${droppedCount + sliverCount} attached file(s) could not be included in this request. After system ` +
        `instructions and conversation history there was too little room left to send a usable amount of their ` +
        `content. The file(s) ARE attached - do not tell the user that no file was provided. Tell them the file ` +
        `could not be read within this model's context window, and suggest a model with a larger context window, ` +
        `a smaller file, or a shorter conversation.`,
    };
    // Everything except the replaced slivers and the note being superseded. Filtering down to the
    // attachments instead also dropped what the note is not about - URL-derived context, attachments with
    // no extractable text - which was masked while the allocation was the only caller, since a turn it
    // dropped nothing on returned early above.
    return [...contentMessages.filter(message => message !== previousNote && !replaced.has(message)), undeliveredNote];
  };

  processedContentMessages = declareUndeliveredAttachments(processedContentMessages);

  // Separate image and non-image messages
  const imageMessages: IMessage[] = fabMessages.filter(
    message =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some(obj => obj.type.startsWith('image'))
  );

  // Check if the user prompt contains a tool_result
  const promptHasToolResult = userPrompt.some(
    msg =>
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.some((block: any) => block.type === 'tool_result')
  );

  /**
   * Combines everything into the message array, system first. Sole owner of the ordering: the safety
   * pass below re-assembles the payload several times to measure it, and a second copy of these two
   * orderings would be free to drift from this one. Both the pairing check and the content/history it
   * applies to are read from the arguments, since the pass rewrites both.
   *
   * tool_use blocks must be immediately followed by tool_result blocks, so when history ends with a
   * tool_use and the prompt carries the matching tool_result, other context moves after the prompt to
   * keep the pair adjacent.
   */
  const assemble = (content: IMessage[], history: IMessage[]): IMessage[] => {
    const lastHistoryMessage = history[history.length - 1];
    const historyEndsWithToolUse =
      lastHistoryMessage?.role === 'assistant' &&
      Array.isArray(lastHistoryMessage.content) &&
      lastHistoryMessage.content.some((block: any) => block.type === 'tool_use');

    return historyEndsWithToolUse && promptHasToolResult
      ? [...systemMessages, ...history, ...userPrompt, ...imageMessages, ...content]
      : [...systemMessages, ...history, ...imageMessages, ...content, ...userPrompt];
  };

  const messages: IMessage[] = assemble(processedContentMessages, processedPreviousMessages);

  // Budget loss outranks history windowing: reporting 'history-limit' whenever historyCount was
  // finite - which is nearly always - made a file the budget had silently zeroed look identical in
  // telemetry to history being windowed exactly as configured, which is why that bug went unnoticed
  // for so long. `contentSqueezed` is needed alongside allRemovedMessages because content cut
  // mid-message is a budget loss that drops no message and so leaves allRemovedMessages empty.
  // Called on BOTH return paths: the overflow path below returns early, so assigning this only at
  // the end left the worst-loss turn reporting the previous call's numbers from a warm container.
  const recordDebugInfo = (finalContentMessages: IMessage[]) => {
    const historyWindowed = previousMessages.length > historyMessages.length;
    const budgetTruncated = allRemovedMessages.length > 0 || contentSqueezed || historyCutMidMessage;
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
    // Shrink content first, then history, re-measuring the real count each round until it fits. One
    // subtraction cannot: the overflow usually lives in history, and an overage measured by the real
    // tokenizer buys less than it looks like when spent against processMessages, which budgets in the
    // character estimate. The notice and the recorder are threaded because this pass really does cut -
    // without them it head-slices a file with nothing appended and reports wasTruncated: false.
    let reducedContentMessages = processedContentMessages;
    let currentTokenCount = finalTokenCount;
    // Null until a round measures one, so the give-up log cannot print a ratio nothing measured.
    let lastRatio: number | null = null;

    // Content is asked to give first, but a round that frees nothing hands over to history rather than
    // retrying forever: processMessages judges against the character estimate, so content that is
    // oversized in real tokens can still look like it fits and come back untouched.
    let contentExhausted = reducedContentMessages.filter(message => message !== undeliveredNote).length === 0;
    for (let round = 0; round < MAX_SAFETY_SHRINK_ROUNDS && currentTokenCount > maxInputTokens; round++) {
      const shrinkingContent = !contentExhausted;
      // Only system messages, images and the user prompt are left, and none is droppable here.
      if (!shrinkingContent && processedPreviousMessages.length === 0) break;

      // The undelivered note is held out of the content slice by identity so the shrink judges only real
      // content; it stays in the assembled payload, so its cost is still measured.
      const before = shrinkingContent
        ? reducedContentMessages.filter(message => message !== undeliveredNote)
        : processedPreviousMessages;
      // Measured on the slice being cut rather than the whole payload: a prose-heavy conversation's
      // overall ratio understates CSV density and under-trims the very slice the round is spending
      // against. Realistic CSV runs about 2.2 chars/token against the estimator's 3.5, prose about 5.6.
      const beforeEstimate = estimateMessagesTokens(before);
      const beforeReal = await calculateTotalTokenLength(before, { estimateOnly: false, tokenizer });
      lastRatio = beforeEstimate > 0 && beforeReal > 0 ? Math.min(8, Math.max(0.25, beforeReal / beforeEstimate)) : 1;
      // No overshoot allowance on top of the conversion: a round that frees too little is corrected by
      // the next one, while asking for more than the overage drops content a smaller cut would have kept.
      const excessInEstimateTokens = Math.ceil((currentTokenCount - maxInputTokens) / lastRatio);
      const budget = Math.max(0, beforeEstimate - excessInEstimateTokens);

      if (shrinkingContent) {
        const reduced = recordContentResult(
          processMessages(before, budget, { truncationNotice: CONTENT_TRUNCATION_NOTICE })
        );
        if (reduced.length < before.length) {
          logger.warn(
            `Final safety pass dropped ${before.length - reduced.length} of ${before.length} ` +
              `attached content message(s) to fit the context window.`
          );
        }
        reducedContentMessages = undeliveredNote ? [...reduced, undeliveredNote] : reduced;
      } else {
        const reduced = processMessages(before, budget);
        // Compared in tokens, not message count: the truncation fallback shrinks messages in place, so a
        // count test reads "same count" as "cannot shrink", discards a real reduction, and sends the
        // still-oversized payload to the throw.
        if (estimateMessagesTokens(reduced.messages) >= beforeEstimate) break;
        logger.warn(
          `Final safety pass also reduced ${before.length} history message(s) to ${reduced.messages.length}: ` +
            `the attached content alone could not absorb the overflow.`
        );
        processedPreviousMessages = recordHistoryResult(reduced);
      }

      // Re-declared every round rather than once at the end, so an attachment this pass drops is named
      // to the model - otherwise it arrives with nothing said and the model denies the file exists, the
      // exact failure this backstop re-entered through last time - and so the note's own ~100 tokens sit
      // inside the count the next round works from.
      reducedContentMessages = declareUndeliveredAttachments(reducedContentMessages);

      const afterTokenCount = await calculateTotalTokenLength(
        assemble(reducedContentMessages, processedPreviousMessages),
        { estimateOnly: false, tokenizer }
      );
      const stalled = afterTokenCount >= currentTokenCount;
      currentTokenCount = afterTokenCount;
      if (stalled) {
        // Content that cannot give any more hands over to history; history that cannot is the end of
        // what this pass can do.
        if (shrinkingContent) contentExhausted = true;
        else break;
      }
    }

    if (currentTokenCount > maxInputTokens) {
      // Deliberately names no single cause: this is reached from four exits (the round cap, content and
      // history both spent, nothing droppable left, history unable to shrink) and only one of them is
      // about system + prompt size. Images are the usual answer when nothing moved at all - they are
      // assembled in at a flat rate and neither branch can touch them - so log the composition instead
      // and let the reader identify which exit it was.
      logger.warn(
        `Final safety pass could not bring the payload under maxInputTokens (${currentTokenCount} > ${maxInputTokens}). ` +
          `Remaining: ${systemMessages.length} system, ${processedPreviousMessages.length} history, ` +
          `${reducedContentMessages.length} content, ${imageMessages.length} image message(s) plus the user prompt` +
          (lastRatio === null
            ? ', with nothing shrinkable to measure.'
            : `, at ${lastRatio.toFixed(2)} real tokens per estimated token.`)
      );
    }

    recordDebugInfo(reducedContentMessages);
    // Ensure tool_use/tool_result pairing integrity after truncation
    return ensureToolPairingIntegrity(assemble(reducedContentMessages, processedPreviousMessages), logger);
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
