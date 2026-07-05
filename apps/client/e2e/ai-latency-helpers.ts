import type { ModelSelectorPage } from './pages/ModelSelectorPage';

/**
 * Extracts the leading version number from a model display name as shown in the AI
 * Settings modal, e.g. "GPT-5.4" -> 5.4, "Claude 4.7 Opus" -> 4.7. Returns null when
 * the name carries no version (so it can be filtered out of "latest" comparisons).
 */
export function parseModelVersion(name: string): number | null {
  const match = name.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

/** Highest-versioned name in the list, or undefined when none carry a parseable version. */
function latestByVersion(names: string[]): string | undefined {
  return names
    .map(name => ({ name, version: parseModelVersion(name) }))
    .filter((m): m is { name: string; version: number } => m.version !== null)
    .sort((a, b) => b.version - a.version)[0]?.name;
}

export interface LatestModels {
  /** Latest available GPT text model, e.g. "GPT-5.5". undefined when none are enabled. */
  gpt?: string;
  /** Latest available Claude (Opus preferred), e.g. "Claude 4.8 Opus". undefined when none. */
  claude?: string;
}

/**
 * Reads the AI Settings modal and returns the latest available GPT and Claude as the
 * CURRENT environment exposes them ("latest" = highest version within the family).
 * Claude prefers the Opus tier (the tier the latency matrix has always used) and falls
 * back to any Claude tier if no Opus is enabled in this environment.
 *
 * Single source of truth for "latest": the CI discovery job calls it to build the
 * full-matrix model list, and resolveSelectedModel calls it for local runs. Replaces the
 * old hard-coded ['GPT-5.4', 'Claude 4.7 Opus'] pair, which silently went stale as models
 * came and went across deployments (staging may expose Claude 4.8 Opus while a preview env
 * only has 4.7, and a hard-coded name simply fails to select).
 */
export async function getLatestModels(modelSelector: ModelSelectorPage): Promise<LatestModels> {
  // One modal open/close for both searches.
  const [gptMatches, claudeMatches] = await modelSelector.getAvailableModelNamesAcross(['GPT', 'Claude']);

  // The modal search matches a card's name OR description, so each result list can include
  // cross-family entries (e.g. a GPT card whose description compares it to Claude). Filter
  // each list to its own family by name before ranking.
  // Also exclude non-text "GPT-*" entries (image/video/audio) that share the GPT prefix.
  const gptNames = gptMatches.filter(n => /^gpt/i.test(n) && !/image|video|sora|audio|tts|whisper|realtime/i.test(n));
  const claudeNames = claudeMatches.filter(n => /claude/i.test(n));

  return {
    gpt: latestByVersion(gptNames),
    // Prefer Opus; fall back to any Claude tier - never a non-Claude model.
    claude: latestByVersion(claudeNames.filter(n => /opus/i.test(n))) ?? latestByVersion(claudeNames),
  };
}

let cachedModel: string | undefined;

/**
 * Resolves the model a latency spec should exercise.
 *
 * In CI the workflow always sets AI_MODEL per matrix cell - the full-matrix branch fans
 * out one cell per discovered model (see the discovery job + getLatestModels), while the
 * single-cell and all-specs branches use the dispatch-selected model - so the override
 * path is what runs there. The modal-discovery path below is the local-dev fallback only.
 */
export async function resolveSelectedModel(modelSelector: ModelSelectorPage): Promise<string> {
  const override = process.env.AI_MODEL?.trim();
  if (override) return override;
  if (cachedModel) return cachedModel;

  const { gpt, claude } = await getLatestModels(modelSelector);
  const candidates = [gpt, claude].filter((m): m is string => !!m);
  if (candidates.length === 0) {
    throw new Error('AI latency suite: no GPT or Claude models available in this environment.');
  }
  // Local fallback only - pick one at random (CI never reaches here, it sets AI_MODEL).
  cachedModel = candidates[Math.floor(Math.random() * candidates.length)];
  return cachedModel;
}

export const dailySeed = new Date()
  .toDateString()
  .split('')
  .reduce((acc, c) => acc * 31 + c.charCodeAt(0), 0);

export function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

export function pickDeterministic<T>(arr: T[], count: number, seed: number): T[] {
  const rand = seededRandom(seed);
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

export interface PromptScenario {
  id: string;
  prompt: string;
  expectedKeywords: string[];
}

export interface PromptResult {
  id: string;
  prompt: string;
  response: string;
  responseTimeMs: number;
  responseTimeSec: number;
  responseRateCharsPerSec: number;
}
