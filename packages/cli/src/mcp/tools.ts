import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_TTS_PROVIDER, PROMPT_TEXT_MAX, ttsRequestSchema, type TTSRequest } from '@bike4mind/common';
import { B4mApiClient, mapApiError, type QuestResponse, type RawDataLake, type RawNotebook } from './b4mApiClient.js';

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
    name: 'send_message',
    title: 'Send message',
    description:
      'Send a chat message and wait for the assistant reply; returns the cited sources (citables) the answer was grounded in.',
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
];

export const TOOL_NAMES = TOOL_META.map(t => t.name);

const listNotebooksShape = {
  search: z.string().optional().describe('Filter notebooks by name/content'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum notebooks to return'),
  page: z.number().int().min(1).default(1).describe('1-based page number; request the next page when hasMore is true'),
};

const getNotebookShape = {
  notebookId: z.string().describe('The notebook (session) id'),
};

const createNotebookShape = {
  name: z.string().optional().describe('Name for the new notebook'),
  projectId: z.string().optional().describe('Project to create the notebook in'),
  dataLakeId: z
    .string()
    .optional()
    .describe("Data lake id or slug to ground the notebook in (see list_lakes); seeds the lake's retrieval defaults"),
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

export async function sendMessage(
  client: B4mApiClient,
  args: { message: string; notebookId?: string; model?: string; systemPrompt?: string }
) {
  const res = await client.sendChat(args);
  const questId = res.id;

  // The wait body carries no citables, so re-fetch the quest for them; it also backs the
  // notebookId should the response omit the echoed sessionId. Best-effort: the reply already
  // succeeded, so a failed fetch only costs the citables (and that fallback id).
  let quest: QuestResponse | undefined;
  try {
    quest = await client.getQuest(questId);
  } catch {
    quest = undefined;
  }
  const notebookId = args.notebookId ?? res.sessionId ?? quest?.sessionId;
  // Drop `metadata`: it can carry `fullContext` passage text that would bloat the MCP client's context.
  // A failed quest fetch leaves citables undefined (omitted), so it never reads as "no sources".
  const citables = quest
    ? (quest.promptMeta?.citables ?? []).map(c => ({
        id: c.id,
        type: c.type,
        title: c.title,
        url: c.url,
        description: c.description,
      }))
    : undefined;

  // The completed quest carries the assistant reply in `responses` (a string
  // array); the scalar `response` is null on the wait path, so prefer `responses`.
  const reply = res.responses && res.responses.length > 0 ? res.responses.join('\n\n') : (res.response ?? '');

  return { notebookId, questId, reply, model: res.model, citables };
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

/**
 * Outcome of a sound-effects generation, in the two shapes the route can yield:
 * a persisted FabFile (id + name + a working signed download URL) when the caller
 * keeps generated audio, or the raw bytes when it does not - so a caller who opted
 * out of persistence, or whose save produced no usable URL, still receives what it
 * was billed for.
 */
export type SoundEffectOutcome =
  | {
      saved: true;
      provider: string;
      contentType: string;
      byteLength: number;
      file: { id: string; fileName?: string; fileUrl: string };
    }
  | { saved: false; provider: string; contentType: string; byteLength: number; audioBase64: string };

export async function generateSoundEffect(
  client: B4mApiClient,
  args: { text: string; provider: string; durationSeconds?: number; promptInfluence?: number; format?: string }
): Promise<SoundEffectOutcome> {
  const { audio, contentType, saved, fabFileId, fileName, fileUrl } = await client.generateSoundEffect(args);
  const base = { provider: args.provider, contentType, byteLength: audio.length };

  // Prefer the persisted-file reference over inlining bytes (mirrors get_file). The
  // route forwards the signed URL it minted at upload, so we use it directly rather
  // than re-resolving via getFile, which fails closed on the just-created file until
  // the async moderation scan runs. If persistence yielded no usable URL, fall back
  // to inlining the bytes the caller was already billed for, so audio is never lost.
  if (saved && fabFileId && fileUrl) {
    return { ...base, saved: true, file: { id: fabFileId, fileName, fileUrl } };
  }
  return { ...base, saved: false, audioBase64: audio.toString('base64') };
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
 * Render a {@link SoundEffectOutcome} as an MCP result. A persisted file becomes
 * a JSON metadata result (carrying the signed URL), exactly like get_file. When
 * the audio was not persisted, it is returned inline as an `audio` content block
 * so the bytes are not lost; the base64 is kept out of structuredContent to avoid
 * duplicating a potentially large payload.
 */
function soundEffectResult(outcome: SoundEffectOutcome): CallToolResult {
  if (outcome.saved) {
    return toResult({
      saved: true,
      provider: outcome.provider,
      contentType: outcome.contentType,
      byteLength: outcome.byteLength,
      file: outcome.file,
    });
  }
  const { audioBase64, ...meta } = outcome;
  return inlineAudioResult(meta, audioBase64, outcome.contentType);
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
    // Too large to inline, so the FabFile is the only way back to the audio; it is
    // reported even without a signed URL so the agent can still name the file.
    const { provider, fabFileId, fileUrl } = response.data;
    return toResult({
      saved: true,
      provider,
      ...(response.fallbackFrom ? { fallbackFrom: response.fallbackFrom } : {}),
      file: { id: fabFileId, ...(fileUrl ? { fileUrl } : {}) },
    });
  }

  const result = response.data;
  const provider = result.provider ?? args.provider ?? DEFAULT_TTS_PROVIDER;
  const metadata = {
    provider,
    ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}),
    format: result.format,
    contentType: result.contentType,
    byteLength: Buffer.from(result.audio, 'base64').length,
  };

  if (result.saved && result.fabFileId && result.fileUrl) {
    return toResult({ ...metadata, saved: true, file: { id: result.fabFileId, fileUrl: result.fileUrl } });
  }

  // No usable URL: inline the billed audio, but still report a saved copy by id,
  // and why a copy was skipped (quota vs. preference) when the route says.
  const inlineMetadata =
    result.saved && result.fabFileId
      ? { ...metadata, saved: true, file: { id: result.fabFileId } }
      : {
          ...metadata,
          saved: false,
          ...(result.saveSkippedReason ? { saveSkippedReason: result.saveSkippedReason } : {}),
        };
  return inlineAudioResult(inlineMetadata, result.audio, result.contentType);
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
    'send_message',
    { title: meta('send_message').title, description: meta('send_message').description, inputSchema: sendMessageShape },
    args => run('ai:chat', () => sendMessage(client, args))
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
        return soundEffectResult(await generateSoundEffect(client, args));
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
}
