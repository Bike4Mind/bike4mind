import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { isAxiosError } from 'axios';
import {
  DEFAULT_TTS_PROVIDER,
  GENERATED_IMAGE_EXTENSION_RE,
  ImageModels,
  ImagePromptResolutionSchema,
  joinReplySlots,
  PROMPT_TEXT_MAX,
  questReplyText,
  ttsRequestSchema,
  type GeneratedAudioResponse,
  type TTSRequest,
} from '@bike4mind/common';
import {
  B4mApiClient,
  mapApiError,
  parseRetryAfterSeconds,
  type QuestResponse,
  type RawDataLake,
  type RawNotebook,
  type RawProject,
  NOTEBOOK_ID_PATTERN,
} from './b4mApiClient.js';
import { logger } from '../utils/Logger.js';

/** Static metadata for each tool, used for registration and the `mcp serve` help text. */
export interface ToolMeta {
  name: string;
  title: string;
  description: string;
  /** API-key scope the tool needs; named in a 403 error so callers know what to grant. */
  scope: string;
}

export const TOOL_META: ToolMeta[] = [
  {
    name: 'list_notebooks',
    title: 'List notebooks',
    description: "List the caller's Bike4Mind notebooks (sessions).",
    scope: 'notebooks:read',
  },
  {
    name: 'get_notebook',
    title: 'Get notebook',
    description: 'Fetch a single notebook by id.',
    scope: 'notebooks:read',
  },
  {
    name: 'create_notebook',
    title: 'Create notebook',
    description:
      'Create a new notebook, optionally inside a project or grounded in a data lake (dataLakeId, see list_lakes). Defaults the name to "New Notebook" when omitted.',
    scope: 'notebooks:write',
  },
  {
    name: 'rename_notebook',
    title: 'Rename notebook',
    description: 'Rename a notebook.',
    scope: 'notebooks:write',
  },
  {
    name: 'clone_notebook',
    title: 'Clone notebook',
    description: 'Clone a notebook into a new one; returns the new notebook.',
    scope: 'notebooks:write',
  },
  {
    name: 'delete_notebook',
    title: 'Delete notebook',
    description:
      'Permanently delete a notebook and the files its owner uploaded to it; this cannot be undone through the API. Requires confirm: true. On a conflict (409) nothing was deleted, so retry.',
    scope: 'notebooks:write',
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'List the Bike4Mind projects the caller can access, including ones shared with them.',
    scope: 'projects:read',
  },
  {
    name: 'get_project',
    title: 'Get project',
    description: 'Fetch a single project by id.',
    scope: 'projects:read',
  },
  {
    name: 'create_project',
    title: 'Create project',
    description:
      'Create a new project. Pass the returned id as projectId to create_notebook to create notebooks inside it.',
    scope: 'projects:write',
  },
  {
    name: 'send_message',
    title: 'Send message',
    description:
      'Send a chat message and wait for the assistant reply, reporting progress while it is generated; returns the cited sources (citables) the answer was grounded in.',
    scope: 'ai:chat',
  },
  {
    name: 'search_knowledge_base',
    title: 'Search knowledge base',
    description: "Semantic search across the caller's notebooks.",
    scope: 'notebooks:read',
  },
  {
    name: 'list_lakes',
    title: 'List data lakes',
    description:
      "List the data lakes the caller can reach. Pass a lake's id as dataLakeId to create_notebook to ground a notebook in it.",
    scope: 'datalake:read',
  },
  { name: 'list_files', title: 'List files', description: "Search the caller's files.", scope: 'files:read' },
  {
    name: 'get_file',
    title: 'Get file',
    description: "Fetch a file's metadata and a signed download URL.",
    scope: 'files:read',
  },
  {
    name: 'generate_sound_effect',
    title: 'Generate sound effect',
    description:
      'Generate a sound effect from a text description. Returns the saved audio file (with a signed download URL) when the caller keeps generated audio, otherwise the audio inline.',
    scope: 'ai:generate',
  },
  {
    name: 'text_to_speech',
    title: 'Text to speech',
    description:
      'Synthesize speech from text. Returns a saved audio file with a signed download URL when available, otherwise audio inline.',
    scope: 'ai:generate',
  },
  {
    name: 'generate_image',
    title: 'Generate image',
    description:
      "Generate an image from a text prompt and wait for the render. Returns the quest and notebook ids plus each image's file name and download URL. Image names are not file ids and do not work with get_file.",
    scope: 'ai:generate',
  },
];

export const TOOL_NAMES = TOOL_META.map(t => t.name);

const listNotebooksShape = {
  search: z.string().optional().describe('Filter notebooks by name/content'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum notebooks to return'),
  page: z.number().int().min(1).default(1).describe('1-based page number; request the next page when hasMore is true'),
};

const notebookId = (description: string) =>
  z.string().regex(NOTEBOOK_ID_PATTERN, 'notebookId must be a 24-character hex ObjectId').describe(description);

const getNotebookShape = {
  notebookId: notebookId('The notebook (session) id'),
};

const createNotebookShape = {
  name: z.string().optional().describe('Name for the new notebook'),
  projectId: z.string().optional().describe('Project to create the notebook in'),
  dataLakeId: z
    .string()
    .optional()
    .describe("Data lake id or slug to ground the notebook in (see list_lakes); seeds the lake's retrieval defaults"),
};

const renameNotebookShape = {
  notebookId: notebookId('The notebook (session) id'),
  name: z.string().min(1).describe('The new name'),
};

const cloneNotebookShape = {
  notebookId: notebookId('The notebook (session) id to clone'),
};

const deleteNotebookShape = {
  notebookId: notebookId('The notebook (session) id to delete'),
  confirm: z.literal(true).describe('Must be true; the delete is permanent'),
};

const listProjectsShape = {
  search: z.string().optional().describe('Filter projects by name'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum projects to return'),
  page: z.number().int().min(1).default(1).describe('1-based page number; request the next page when hasMore is true'),
};

const getProjectShape = {
  projectId: z.string().describe('The project id'),
};

const createProjectShape = {
  name: z.string().min(1).describe('Name for the new project; must be unique among your projects'),
  description: z.string().min(1).describe('Short description of the project'),
  sessionIds: z.array(z.string()).optional().describe('Notebook (session) ids to add to the project'),
  fileIds: z.array(z.string()).optional().describe('File ids to add to the project'),
};

const sendMessageShape = {
  message: z.string().describe('The message to send'),
  notebookId: z
    .string()
    .optional()
    .describe(
      'Notebook to send to; omit to start a new notebook (its id is returned as notebookId, pass it back to continue the thread)'
    ),
  model: z.string().optional().describe('Model id to use; defaults to the instance default'),
  systemPrompt: z
    .string()
    .max(PROMPT_TEXT_MAX)
    .optional()
    .describe('Caller-supplied system-prompt text for this message only; refines but never overrides other guidance'),
};

const searchKnowledgeBaseShape = {
  query: z.string().describe('The search query'),
  limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
  minSimilarity: z.number().min(0).max(1).optional().describe('Minimum cosine similarity threshold'),
};

const listLakesShape = {
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum lakes to return'),
  cursor: z.string().optional().describe('Pass back nextCursor from the previous page'),
};

const listFilesShape = {
  search: z.string().optional().describe('Filter files by name/content'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum files to return'),
  page: z.number().int().min(1).default(1).describe('1-based page number; request the next page when hasMore is true'),
};

const getFileShape = {
  fileId: z.string().describe('The file id'),
};

// Bounds mirror `soundEffectsRequestSchema` (@bike4mind/common) and the ElevenLabs
// sound-generation limits; keep in sync with the route's parse.
const generateSoundEffectShape = {
  text: z.string().min(1).max(1000).describe('Text description of the sound effect to generate'),
  provider: z.enum(['elevenlabs']).default('elevenlabs').describe('Sound-generation provider'),
  durationSeconds: z
    .number()
    .min(0.5)
    .max(30)
    .optional()
    .describe('Length of the sound in seconds (0.5-30); omit to let the provider choose'),
  promptInfluence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('How strictly to follow the prompt (0 = loose, 1 = strict)'),
  format: z.string().optional().describe('Provider output encoding token, e.g. mp3_44100_128'),
};

const generateImageShape = {
  prompt: z.string().min(1).describe('Text description of the image to generate'),
  model: z.string().default(ImageModels.GPT_IMAGE_2).describe('Image model id, e.g. gpt-image-2'),
  size: z.string().optional().describe("Image size as 'widthxheight', e.g. 1024x1024; omit for the model default"),
  notebookId: z.string().optional().describe('Notebook to add the image to; omit to create a new one'),
  projectId: z.string().optional().describe('Project for the new notebook when notebookId is omitted'),
  promptResolution: ImagePromptResolutionSchema.optional().describe(
    "'auto' (default) rewrites the prompt against the notebook history; 'literal' sends it as written"
  ),
};

const textToSpeechShape = {
  ...ttsRequestSchema.omit({ encoding: true }).shape,
  text: ttsRequestSchema.shape.text.describe('Text to speak'),
  provider: ttsRequestSchema.shape.provider.describe(`Speech provider; defaults to ${DEFAULT_TTS_PROVIDER}`),
  preview: ttsRequestSchema.shape.preview.describe('Skip saving a copy to the file browser'),
};

function notebookSummary(n: RawNotebook) {
  return {
    id: n.id,
    name: n.name,
    model: n.lastUsedModel ?? undefined,
    createdAt: n.createdAt ?? n.firstCreated,
    updatedAt: n.updatedAt ?? n.lastUpdated,
  };
}

function projectSummary(p: RawProject) {
  return { id: p.id, name: p.name, createdAt: p.createdAt };
}

function lakeSummary(l: RawDataLake) {
  return {
    id: l.id,
    name: l.name,
    slug: l.slug,
    description: l.description ?? undefined,
    builtIn: l.built_in,
    status: l.status,
    fileCount: l.file_count,
  };
}

export async function listNotebooks(client: B4mApiClient, args: { search?: string; limit: number; page?: number }) {
  const { data, hasMore } = await client.listNotebooks(args);
  return { notebooks: data.map(notebookSummary), hasMore };
}

export async function getNotebook(client: B4mApiClient, args: { notebookId: string }) {
  return client.getNotebook(args.notebookId);
}

export async function createNotebook(
  client: B4mApiClient,
  args: { name?: string; projectId?: string; dataLakeId?: string }
) {
  // POST /api/sessions/create hard-requires a name; default to the web app's
  // convention when the caller omits one so a nameless create still succeeds.
  return client.createNotebook({ ...args, name: args.name ?? 'New Notebook' });
}

export async function renameNotebook(client: B4mApiClient, args: { notebookId: string; name: string }) {
  return notebookSummary(await client.renameNotebook(args.notebookId, args.name));
}

export async function cloneNotebook(client: B4mApiClient, args: { notebookId: string }) {
  return notebookSummary(await client.cloneNotebook(args.notebookId));
}

export async function deleteNotebook(client: B4mApiClient, args: { notebookId: string; confirm?: boolean }) {
  // The MCP input schema already rejects anything but `true`; this guards direct callers.
  if (args.confirm !== true) {
    throw new Error('delete_notebook requires confirm: true');
  }
  const { newLastNotebookId } = await client.deleteNotebook(args.notebookId);
  return { deleted: true, notebookId: args.notebookId, newLastNotebookId };
}

export async function listProjects(client: B4mApiClient, args: { search?: string; limit: number; page?: number }) {
  const { data, hasMore } = await client.listProjects(args);
  return { projects: data.map(projectSummary), hasMore };
}

export async function getProject(client: B4mApiClient, args: { projectId: string }) {
  return client.getProject(args.projectId);
}

export async function createProject(
  client: B4mApiClient,
  args: { name: string; description: string; sessionIds?: string[]; fileIds?: string[] }
) {
  return projectSummary(await client.createProject(args));
}

/**
 * Queue a chat turn and poll its quest to completion. A failed turn ends `type: 'error'` with its
 * explanation as the reply, which is returned as-is like any other reply.
 */
export async function sendMessage(
  client: B4mApiClient,
  args: { message: string; notebookId?: string; model?: string; systemPrompt?: string },
  { intervalMs = CHAT_POLL_INTERVAL_MS, timeoutMs = CHAT_POLL_TIMEOUT_MS, ...poll }: PollOptions = {}
) {
  const ack = await client.sendChat(args);
  const questId = ack.id;
  const quest = await pollQuest(
    client,
    {
      questId,
      ref: questRef(questId, ack.sessionId),
      task: 'chat completion',
      scope: 'ai:chat',
      isFinished: isSettled,
    },
    { ...poll, timeoutMs, interval: elapsedMs => chatPollInterval(elapsedMs, intervalMs) }
  );

  const notebookId = args.notebookId ?? ack.sessionId ?? quest.sessionId;
  // Drop `metadata`: it can carry `fullContext` passage text that would bloat the MCP client's context.
  const citables = (quest.promptMeta?.citables ?? []).map(c => ({
    id: c.id,
    type: c.type,
    title: c.title,
    url: c.url,
    description: c.description,
  }));

  return { notebookId, questId, reply: replyText(quest), model: ack.model, citables };
}

export async function searchKnowledgeBase(
  client: B4mApiClient,
  args: { query: string; limit: number; minSimilarity?: number }
) {
  const results = await client.searchKnowledgeBase(args);
  return { results };
}

export async function listLakes(client: B4mApiClient, args: { limit: number; cursor?: string }) {
  const { data, nextCursor } = await client.listDataLakes(args);
  return { lakes: data.map(lakeSummary), nextCursor };
}

export async function listFiles(client: B4mApiClient, args: { search?: string; limit: number; page?: number }) {
  const { data, hasMore } = await client.listFiles(args);
  return { files: data, hasMore };
}

export async function getFile(client: B4mApiClient, args: { fileId: string }) {
  return client.getFile(args.fileId);
}

export async function generateSoundEffect(
  client: B4mApiClient,
  args: { text: string; provider: string; durationSeconds?: number; promptInfluence?: number; format?: string }
): Promise<CallToolResult> {
  const response = await client.generateSoundEffect(args);
  return generatedAudioResult(response, { provider: args.provider });
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Aborts the poll when the MCP client cancels the call. */
  signal?: AbortSignal;
  /**
   * Called after each non-terminal poll with the quest it read (absent when that poll failed), so
   * the tool can keep the client's request alive and report how far the quest has got.
   */
  onProgress?: (elapsedMs: number, quest?: QuestResponse) => Promise<void> | void;
  /** Named in poll-failure messages, e.g. an unreachable server. */
  baseURL?: string;
}

const IMAGE_POLL_INTERVAL_MS = 2000;
// Renders typically finish well under a minute; the cap only stops a wedged quest from
// holding the tool call open indefinitely.
const IMAGE_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const CHAT_POLL_INTERVAL_MS = 2000;
// Most replies land inside the fast window. Past it the poll slows down, because the quest GET
// counts against the key's per-minute limit (only the daily one exempts it) and a few long turns
// polled in parallel at 2s would 429 the key's next /api/chat POST.
const CHAT_POLL_FAST_WINDOW_MS = 30 * 1000;
const CHAT_POLL_SLOW_INTERVAL_MS = 5000;
// A turn with tool rounds or a slow reasoning model can run for minutes, so this cap sits well
// above the image one; it too only stops a wedged quest from holding the call open.
const CHAT_POLL_TIMEOUT_MS = 15 * 60 * 1000;
// The quest is already queued and billed, so a transient poll failure (5xx, 429, network)
// must not abandon it; only a run of them does.
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const chatPollInterval = (elapsedMs: number, intervalMs: number) =>
  elapsedMs < CHAT_POLL_FAST_WINDOW_MS ? intervalMs : Math.max(intervalMs, CHAT_POLL_SLOW_INTERVAL_MS);

// A failed dispatch (ChatCompletionInvoke) writes `type: 'error'` without touching `status`, which
// stays 'running', so the type check is what ends the poll on it.
const isSettled = (q: QuestResponse) => q.status === 'done' || q.status === 'stopped' || q.type === 'error';

// `status` is optional on the poll response; a render that already carries its images is
// finished whatever its status says.
const isImageSettled = (q: QuestResponse) => isSettled(q) || (!q.status && !!q.images?.length);

// Derived here rather than read from the poll's `reply` because older servers return the stored
// scalar, which can be a stale rapid-reply prefix of the streamed slots.
const replyText = (q: QuestResponse) => questReplyText(q, joinReplySlots) ?? '';

const questRef = (questId: string, notebookId?: string) =>
  `quest ${questId}${notebookId ? `, notebook ${notebookId}` : ''}`;

const isRateLimited = (err: unknown) => isAxiosError(err) && err.response?.status === 429;

const isPermanentApiError = (err: unknown) => {
  const status = isAxiosError(err) ? err.response?.status : undefined;
  return status === 401 || status === 403 || status === 404;
};

interface QuestPoll {
  questId: string;
  /** Identifies the quest in error messages, so the caller can find the turn afterwards. */
  ref: string;
  /** What the quest is doing, e.g. "image generation"; names it in a timeout message. */
  task: string;
  /** API-key scope named in a poll failure's permission hint. */
  scope: string;
  isFinished: (q: QuestResponse) => boolean;
}

/** Poll a queued quest until `isFinished`, the timeout, a permanent poll failure, or an abort. */
async function pollQuest(
  client: B4mApiClient,
  { questId, ref, task, scope, isFinished }: QuestPoll,
  {
    interval,
    timeoutMs,
    sleep = defaultSleep,
    signal,
    onProgress,
    baseURL = '',
  }: Omit<PollOptions, 'intervalMs'> & { interval: (elapsedMs: number) => number; timeoutMs: number }
): Promise<QuestResponse> {
  const started = Date.now();
  let failures = 0;
  let retryAfterMs = 0;
  for (;;) {
    signal?.throwIfAborted();
    let quest: QuestResponse | undefined;
    try {
      quest = await client.getQuest(questId);
      failures = 0;
      if (isFinished(quest)) return quest;
    } catch (err) {
      // The per-minute key limit is shared with other calls, so a 429 says nothing about the quest.
      if (isRateLimited(err)) {
        retryAfterMs =
          (parseRetryAfterSeconds(isAxiosError(err) && err.response?.headers?.['retry-after']) ?? 0) * 1000;
      } else {
        failures += 1;
        if (isPermanentApiError(err) || failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          throw new Error(`${mapApiError(err, baseURL, scope)} (${ref}; the ${task} may still complete)`);
        }
      }
    }
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) {
      throw new Error(`${task} did not finish within ${Math.round(timeoutMs / 1000)}s (${ref})`);
    }
    // A cancel can land while getQuest is in flight; report nothing for a request the client dropped.
    signal?.throwIfAborted();
    try {
      await onProgress?.(elapsed, quest);
    } catch (err) {
      // Progress is advisory: a lost notification must not fail a quest that is still running.
      logger.warn(`mcp: progress notification failed (${ref}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const intervalMs = interval(elapsed);
    await sleep(Math.min(Math.max(intervalMs, retryAfterMs), Math.max(timeoutMs - elapsed, intervalMs)));
    retryAfterMs = 0;
  }
}

/**
 * Queue an image render and poll its quest to completion. A failed render still
 * resolves `status: 'done'`, so `type: 'error'` (reason in `reply`) is the failure signal.
 * Generated images are not FabFiles, so there is no file id: the quest id is the handle,
 * and each image is its generated-file name plus the URL the quest poll resolves for it
 * (`fileUrl` is absent when the server has no CDN configured).
 */
export async function generateImage(
  client: B4mApiClient,
  args: Parameters<B4mApiClient['generateImage']>[0],
  { intervalMs = IMAGE_POLL_INTERVAL_MS, timeoutMs = IMAGE_POLL_TIMEOUT_MS, ...poll }: PollOptions = {}
) {
  const ack = await client.generateImage(args);
  const questId = ack.quest.id;
  const ref = questRef(questId, ack.quest.sessionId);
  const quest = await pollQuest(
    client,
    { questId, ref, task: 'image generation', scope: 'ai:generate', isFinished: isImageSettled },
    { ...poll, timeoutMs, interval: () => intervalMs }
  );

  if (quest.status === 'stopped') {
    throw new Error(`image generation was stopped (${ref})`);
  }
  if (quest.type === 'error') {
    const code = quest.errorCode ? `${quest.errorCode}: ` : '';
    throw new Error(`${code}${quest.reply || 'image generation failed'} (${ref})`);
  }

  const urls = new Map((quest.files ?? []).map(f => [f.name, f.url]));
  const images = (quest.images ?? [])
    .filter(name => GENERATED_IMAGE_EXTENSION_RE.test(name))
    .map(name => ({ fileName: name, fileUrl: urls.get(name) }));
  if (images.length === 0) {
    throw new Error(`${quest.reply || 'image generation finished without producing an image'} (${ref})`);
  }

  return {
    notebookId: quest.sessionId ?? ack.quest.sessionId,
    questId,
    model: args.model,
    enhancedPrompt: ack.enhancedPrompt,
    images,
  };
}

function toResult(value: unknown): CallToolResult {
  const structuredContent =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Render a generated-audio response as an MCP result, shared by every audio tool.
 * Oversized audio is reported by its signed URL; a saved copy with a usable URL is
 * reported as a file (like get_file) with no inline bytes. Otherwise the audio rides
 * inline as an `audio` block so a billed result is never lost, with any saved copy
 * still named by id and a skipped save explained. The route forwards the signed URL
 * it minted at upload, so no getFile re-fetch is needed (that fails closed until
 * the async moderation scan runs).
 */
function generatedAudioResult(
  response: GeneratedAudioResponse,
  endpointMetadata: Record<string, unknown>
): CallToolResult {
  const metadata = { ...endpointMetadata, contentType: response.contentType };
  const saveSkippedReason = response.saveSkippedReason ? { saveSkippedReason: response.saveSkippedReason } : {};
  const file = response.fabFileId
    ? {
        id: response.fabFileId,
        ...(response.fileName ? { fileName: response.fileName } : {}),
        ...(response.fileUrl ? { fileUrl: response.fileUrl } : {}),
      }
    : undefined;

  if (response.delivery === 'url') {
    return toResult({
      ...metadata,
      byteLength: response.bytes,
      url: response.url,
      saved: response.saved === true,
      ...(response.saved && file ? { file } : {}),
      ...saveSkippedReason,
    });
  }

  const byteLength = Buffer.from(response.audio, 'base64').length;
  if (response.saved && file && file.fileUrl) {
    return toResult({ ...metadata, byteLength, saved: true, file });
  }

  const inlineMetadata =
    response.saved && file
      ? { ...metadata, byteLength, saved: true, file }
      : { ...metadata, byteLength, saved: false, ...saveSkippedReason };
  return inlineAudioResult(inlineMetadata, response.audio, response.contentType);
}

/**
 * Metadata as JSON text plus the audio as an MCP `audio` block. The base64 stays
 * out of structuredContent so a potentially large payload is not duplicated.
 */
function inlineAudioResult(meta: Record<string, unknown>, audioBase64: string, mimeType: string): CallToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(meta, null, 2) },
      { type: 'audio', data: audioBase64, mimeType },
    ],
    structuredContent: meta,
  };
}

export async function textToSpeech(client: B4mApiClient, args: Omit<TTSRequest, 'encoding'>): Promise<CallToolResult> {
  const response = await client.synthesizeSpeech(args);
  if (response.kind === 'saved-too-large') {
    // A server predating the oversized-audio URL offload answers 413, leaving the
    // FabFile as the only way back to the audio; it is reported even without a
    // signed URL so the agent can still name the file.
    const { provider, fabFileId, fileUrl } = response.data;
    return toResult({
      saved: true,
      provider,
      ...(response.fallbackFrom ? { fallbackFrom: response.fallbackFrom } : {}),
      file: { id: fabFileId, ...(fileUrl ? { fileUrl } : {}) },
    });
  }

  const result = response.data;
  return generatedAudioResult(result, {
    provider: result.provider ?? args.provider ?? DEFAULT_TTS_PROVIDER,
    ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}),
    format: result.format,
  });
}

/** The slice of a tool call's request context a progress reporter needs. */
interface ProgressContext {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

/**
 * Turn a quest poll's progress callback into MCP `notifications/progress`, or nothing when the
 * client sent no progressToken. Progress also lets a client that resets its request timeout on
 * progress wait out a slow quest.
 */
function progressReporter(
  { _meta, sendNotification }: ProgressContext,
  describe: (quest?: QuestResponse) => string
): PollOptions['onProgress'] {
  const progressToken = _meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return (elapsedMs, quest) =>
    sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: Math.floor(elapsedMs / 1000), message: describe(quest) },
    });
}

// Partial text is persisted only every few seconds while a turn streams, so this is a coarse
// "still producing" signal rather than a live count.
function chatProgress(quest?: QuestResponse): string {
  if (quest?.status !== 'running') return 'waiting for the reply to start';
  const characters = replyText(quest).length;
  return characters > 0 ? `generating reply (${characters} characters so far)` : 'generating reply';
}

/**
 * Register the Bike4Mind MCP tools on `server`. Each handler is wrapped so an
 * API failure becomes a structured `isError` result carrying a friendly message
 * (see {@link mapApiError}) rather than throwing across the transport.
 */
export function registerTools(server: McpServer, client: B4mApiClient): void {
  const baseURL = client.baseURL;
  const meta = (name: string) => TOOL_META.find(t => t.name === name)!;

  const run = async (scope: string, fn: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return toResult(await fn());
    } catch (err) {
      return errorResult(mapApiError(err, baseURL, scope));
    }
  };

  server.registerTool(
    'list_notebooks',
    {
      title: meta('list_notebooks').title,
      description: meta('list_notebooks').description,
      inputSchema: listNotebooksShape,
    },
    args => run('notebooks:read', () => listNotebooks(client, args))
  );

  server.registerTool(
    'get_notebook',
    { title: meta('get_notebook').title, description: meta('get_notebook').description, inputSchema: getNotebookShape },
    args => run('notebooks:read', () => getNotebook(client, args))
  );

  server.registerTool(
    'create_notebook',
    {
      title: meta('create_notebook').title,
      description: meta('create_notebook').description,
      inputSchema: createNotebookShape,
    },
    args => run('notebooks:write', () => createNotebook(client, args))
  );

  server.registerTool(
    'rename_notebook',
    {
      title: meta('rename_notebook').title,
      description: meta('rename_notebook').description,
      inputSchema: renameNotebookShape,
    },
    args => run('notebooks:write', () => renameNotebook(client, args))
  );

  server.registerTool(
    'clone_notebook',
    {
      title: meta('clone_notebook').title,
      description: meta('clone_notebook').description,
      inputSchema: cloneNotebookShape,
    },
    args => run('notebooks:write', () => cloneNotebook(client, args))
  );

  server.registerTool(
    'delete_notebook',
    {
      title: meta('delete_notebook').title,
      description: meta('delete_notebook').description,
      inputSchema: deleteNotebookShape,
    },
    args => run('notebooks:write', () => deleteNotebook(client, args))
  );

  server.registerTool(
    'list_projects',
    {
      title: meta('list_projects').title,
      description: meta('list_projects').description,
      inputSchema: listProjectsShape,
    },
    args => run('projects:read', () => listProjects(client, args))
  );

  server.registerTool(
    'get_project',
    { title: meta('get_project').title, description: meta('get_project').description, inputSchema: getProjectShape },
    args => run('projects:read', () => getProject(client, args))
  );

  server.registerTool(
    'create_project',
    {
      title: meta('create_project').title,
      description: meta('create_project').description,
      inputSchema: createProjectShape,
    },
    args => run('projects:write', () => createProject(client, args))
  );

  server.registerTool(
    'send_message',
    { title: meta('send_message').title, description: meta('send_message').description, inputSchema: sendMessageShape },
    (args, extra) =>
      run('ai:chat', () =>
        sendMessage(client, args, { signal: extra.signal, baseURL, onProgress: progressReporter(extra, chatProgress) })
      )
  );

  server.registerTool(
    'search_knowledge_base',
    {
      title: meta('search_knowledge_base').title,
      description: meta('search_knowledge_base').description,
      inputSchema: searchKnowledgeBaseShape,
    },
    args => run('notebooks:read', () => searchKnowledgeBase(client, args))
  );

  server.registerTool(
    'list_lakes',
    { title: meta('list_lakes').title, description: meta('list_lakes').description, inputSchema: listLakesShape },
    args => run('datalake:read', () => listLakes(client, args))
  );

  server.registerTool(
    'list_files',
    { title: meta('list_files').title, description: meta('list_files').description, inputSchema: listFilesShape },
    args => run('files:read', () => listFiles(client, args))
  );

  server.registerTool(
    'get_file',
    { title: meta('get_file').title, description: meta('get_file').description, inputSchema: getFileShape },
    args => run('files:read', () => getFile(client, args))
  );

  server.registerTool(
    'generate_sound_effect',
    {
      title: meta('generate_sound_effect').title,
      description: meta('generate_sound_effect').description,
      inputSchema: generateSoundEffectShape,
    },
    async args => {
      try {
        return await generateSoundEffect(client, args);
      } catch (err) {
        return errorResult(mapApiError(err, baseURL, 'ai:generate'));
      }
    }
  );

  server.registerTool(
    'text_to_speech',
    {
      title: meta('text_to_speech').title,
      description: meta('text_to_speech').description,
      inputSchema: textToSpeechShape,
    },
    async args => {
      try {
        return await textToSpeech(client, args);
      } catch (err) {
        return errorResult(mapApiError(err, baseURL, 'ai:generate'));
      }
    }
  );

  server.registerTool(
    'generate_image',
    {
      title: meta('generate_image').title,
      description: meta('generate_image').description,
      inputSchema: generateImageShape,
    },
    (args, extra) =>
      run('ai:generate', () =>
        generateImage(client, args, {
          signal: extra.signal,
          baseURL,
          onProgress: progressReporter(extra, () => 'rendering image'),
        })
      )
  );
}
