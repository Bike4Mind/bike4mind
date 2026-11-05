import { readFile } from 'node:fs/promises';
import type { OllamaModelFacts, OllamaRequestSettings, OllamaRequestSettingsReader } from '@bike4mind/llm-adapters';
import { modelBlobsOf } from '@bike4mind/local-models';
import {
  effortSent,
  GENERATION_FIELDS,
  LOCAL_OLLAMA_RUNTIME_ID,
  localModelId,
  MODEL_SETTINGS_FILE_NAME,
  parseModelSettingsFile,
  quotedForMessage,
  REASONING_EFFORT_SETTINGS,
  type GenerationField,
  type ModelContextSetting,
  type ModelEffort,
  type ModelSettings,
} from '@bike4mind/local-models/model-settings';
import { desktopUserDataFile, type DesktopDirsOptions } from '@bike4mind/local-models/servers';
import { DEFAULT_OLLAMA_PORT } from '../utils/ollamaHost.js';

/** A path to read Desktop's per-model settings from instead of its userData folder, or `off` to ignore them. */
export const DESKTOP_MODEL_SETTINGS_ENV = 'B4M_DESKTOP_MODEL_SETTINGS';

const OFF_VALUES: ReadonlySet<string> = new Set(['off', '0', 'false', 'no', 'none']);

/** Desktop's settings file cannot be used; the message names it and how to go on. */
export class DesktopModelSettingsError extends Error {
  constructor(
    readonly filePath: string,
    message: string
  ) {
    super(message);
    this.name = 'DesktopModelSettingsError';
  }
}

function fileProblem(filePath: string, problem: string): DesktopModelSettingsError {
  return new DesktopModelSettingsError(
    filePath,
    `Desktop's model settings file ${filePath} ${problem}. Fix it in Desktop or by hand, or set ${DESKTOP_MODEL_SETTINGS_ENV}=off to run without it.`
  );
}

export interface DesktopModelSettingsFile {
  path: string;
  /** Named by B4M_DESKTOP_MODEL_SETTINGS, so it must exist. */
  fromEnv: boolean;
}

export type DesktopModelSettingsLocator = () => Promise<DesktopModelSettingsFile | null>;

/**
 * Finds the file on each read: the env's path, else model-settings.json in the first Desktop userData folder
 * holding it (null when Desktop has none). Null instead of a locator when the env turns the settings off.
 */
export function desktopModelSettingsFile(opts: DesktopDirsOptions = {}): DesktopModelSettingsLocator | null {
  const env = opts.env ?? process.env;
  const value = env[DESKTOP_MODEL_SETTINGS_ENV]?.trim();
  if (value && OFF_VALUES.has(value.toLowerCase())) return null;
  if (value) return async () => ({ path: value, fromEnv: true });
  return async () => {
    const file = await desktopUserDataFile(MODEL_SETTINGS_FILE_NAME, opts);
    return file === null ? null : { path: file, fromEnv: false };
  };
}

export interface ReadModelSettingsOptions {
  platform?: NodeJS.Platform;
  readText?: (filePath: string) => Promise<string>;
  retryDelayMs?: number;
}

const RENAME_RACE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

async function readSettingsText(filePath: string, opts: ReadModelSettingsOptions): Promise<string> {
  const read = opts.readText ?? ((file: string) => readFile(file, 'utf8'));
  try {
    return await read(filePath);
  } catch (error) {
    // Desktop saves through a temp file and rename, which Windows can refuse a reader for a moment.
    const code = errorCode(error);
    if ((opts.platform ?? process.platform) !== 'win32' || code === undefined || !RENAME_RACE_CODES.has(code))
      throw error;
    await new Promise(resolve => setTimeout(resolve, opts.retryDelayMs ?? 50));
    return read(filePath);
  }
}

/**
 * One model's settings, read fresh so a hand fix applies on the next turn. No file in Desktop's folder holds none;
 * a missing env file, a file that cannot be read or parsed, or a broken entry for this model rejects. Values this
 * version does not support are left unset by the parser.
 */
export async function readDesktopModelSettings(
  file: DesktopModelSettingsFile | null,
  modelId: string,
  opts: ReadModelSettingsOptions = {}
): Promise<ModelSettings> {
  if (!file) return {};
  let text: string;
  try {
    text = await readSettingsText(file.path, opts);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (!file.fromEnv) return {};
      throw new DesktopModelSettingsError(
        file.path,
        `${DESKTOP_MODEL_SETTINGS_ENV} names ${file.path}, a file that does not exist. Point it at Desktop's model-settings.json, or set it to off to run without it.`
      );
    }
    throw fileProblem(file.path, `could not be read (${code ?? String(error)})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw fileProblem(file.path, 'is not valid JSON');
  }
  const stored = parseModelSettingsFile(raw);
  if (!stored) throw fileProblem(file.path, 'does not hold model settings');
  const field = stored.invalid.get(modelId);
  if (field === null)
    throw fileProblem(file.path, `has an entry for ${quotedForMessage(modelId)} that is not a set of settings`);
  if (field !== undefined)
    throw fileProblem(file.path, `has an invalid ${quotedForMessage(field)} for ${quotedForMessage(modelId)}`);
  return stored.settings.get(modelId) ?? {};
}

/** Desktop's runtime id for the Ollama at `baseUrl`: only its own daemon's, at this computer's default address. */
export function desktopRuntimeIdForHost(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  return url.protocol === 'http:' && loopback && url.port === String(DEFAULT_OLLAMA_PORT)
    ? LOCAL_OLLAMA_RUNTIME_ID
    : null;
}

const OLLAMA_SAMPLING: ReadonlyMap<GenerationField, string> = new Map([
  ['temperature', 'temperature'],
  ['topP', 'top_p'],
  ['topK', 'top_k'],
  ['minP', 'min_p'],
  ['repeatPenalty', 'repeat_penalty'],
  ['presencePenalty', 'presence_penalty'],
]);

/**
 * Fixed: the size, at most the trained length. Auto: Desktop sizes it from this computer's memory and its own
 * Settings, which the CLI does not read, so the CLI keeps its own size and only applies the model's cap.
 */
function contextTokens(context: ModelContextSetting | undefined, facts: OllamaModelFacts): number | undefined {
  if (!context) return undefined;
  const limit = (tokens: number) =>
    facts.trainedContext === undefined ? tokens : Math.min(tokens, facts.trainedContext);
  if (context.mode === 'fixed') return limit(context.tokens);
  return context.maxTokens === undefined ? undefined : Math.min(facts.defaultNumCtx, limit(context.maxTokens));
}

/** Mirrors ollamaDraft in apps/desktop main/chat/loadOptions.ts: an MTP head or a Modelfile DRAFT layer. */
function speculates(facts: OllamaModelFacts): boolean {
  const layers = Object.entries(facts.modelInfo).find(([key]) => key.endsWith('.nextn_predict_layers'))?.[1];
  if (typeof layers === 'number' && Number.isFinite(layers) && layers > 0) return true;
  return (modelBlobsOf(facts.modelfile).draftBlobs?.length ?? 0) > 0;
}

/**
 * The `think` Desktop sends for a model's effort while the conversation's is `default`: only on a model whose
 * template names effort levels (gpt-oss), the nearest listed one; a stored `none` turns thinking off as Desktop
 * does there (apps/desktop main/chat/OllamaLocal.ts thinkField).
 */
function effortThink(effort: ModelEffort | undefined, facts: OllamaModelFacts): boolean | string | undefined {
  if (!effort || !facts.capabilities.includes('thinking')) return undefined;
  const values = facts.thinkingValues ?? [];
  const levels = REASONING_EFFORT_SETTINGS.filter(setting => setting !== 'default' && values.includes(setting));
  const level = effortSent(effort, levels);
  if (level === undefined || level !== 'none') return level;
  if (values.includes(false)) return false;
  return values.find((value): value is string => typeof value === 'string');
}

/** What one Ollama request carries for a model's Desktop settings. */
export function ollamaRequestSettings(settings: ModelSettings, facts: OllamaModelFacts): OllamaRequestSettings {
  const options: Record<string, number> = {};
  for (const field of GENERATION_FIELDS) {
    const name = OLLAMA_SAMPLING.get(field);
    const value = settings.generation?.[field];
    if (name !== undefined && value !== undefined && Number.isFinite(value)) options[name] = value;
  }
  if (settings.draftTokens !== undefined && speculates(facts)) options.draft_num_predict = settings.draftTokens;
  const numCtx = contextTokens(settings.context, facts);
  const maxOutputTokens = settings.generation?.maxOutputTokens;
  const think = effortThink(settings.effort, facts);
  return {
    ...(numCtx !== undefined ? { numCtx } : {}),
    ...(settings.keepAlive !== undefined ? { keepAlive: settings.keepAlive } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(think !== undefined ? { think } : {}),
  };
}

/**
 * Applies Desktop's settings for `runtimeId`'s models (`local:<runtime>:<model>`) on every request; undefined when
 * the env turns them off. Read-only: the CLI never writes the file.
 */
export function desktopRequestSettings(
  runtimeId: string,
  opts: DesktopDirsOptions = {}
): OllamaRequestSettingsReader | undefined {
  const locate = desktopModelSettingsFile(opts);
  if (!locate) return undefined;
  return async (model, facts) =>
    ollamaRequestSettings(
      await readDesktopModelSettings(await locate(), localModelId(runtimeId, model), { platform: opts.platform }),
      facts
    );
}
