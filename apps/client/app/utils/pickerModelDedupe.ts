import { ModelBackend, type ModelInfo } from '@bike4mind/common';

// Bedrock cross-region inference profiles prefix the foundation-model id with a geography.
const BEDROCK_PROFILE_PREFIX = /^(global|us-gov|us|eu|apac|jp|au|ca)\./;
const VERSION_SUFFIX = /-v(\d+(?::\d+)?)$/;
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;
// Four-digit MMDD snapshots (gpt-4-0613). Month and day are range-checked so ids ending in other
// four-digit numbers (a size or a YYMM stamp) are not mistaken for one.
const SHORT_DATE_SUFFIX = /-((?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))$/;
const LATEST_SUFFIX = /-latest$/;

type ParsedModelId = {
  /** Backend plus the id with its profile prefix and release suffixes removed. */
  base: string;
  /** The explicit release (date, else version). Null for an alias such as `gpt-4.1` or `-latest`. */
  release: string | null;
};

type Preference = { model: ModelInfo; tuple: number[] };

function parseModelId(model: Pick<ModelInfo, 'id' | 'backend'>): ParsedModelId {
  let id = String(model.id).toLowerCase();
  if (model.backend === ModelBackend.Bedrock) id = id.replace(BEDROCK_PROFILE_PREFIX, '');

  const version = VERSION_SUFFIX.exec(id)?.[1] ?? null;
  id = id.replace(VERSION_SUFFIX, '');

  const dateMatch = DATE_SUFFIX.exec(id) ?? SHORT_DATE_SUFFIX.exec(id);
  if (dateMatch) id = id.slice(0, dateMatch.index);
  else id = id.replace(LATEST_SUFFIX, '');

  return { base: `${model.backend}:${id}`, release: dateMatch?.[1] ?? version };
}

/**
 * Identity of one release behind an id, per route: a Bedrock foundation id and its `global.`/`us.`
 * inference profiles share one, but two ids carrying different date or version tokens never do.
 * Aliases (no token) key on their base alone; `dedupeModelsForPicker` folds them into a sole release.
 * The backend stays in the key, so a model served both direct and on Bedrock keeps one row per route.
 */
export function canonicalModelKey(model: Pick<ModelInfo, 'id' | 'backend'>): string {
  const { base, release } = parseModelId(model);
  return release ? `${base}@${release}` : base;
}

/** Lower sorts first. A profile beats a bare foundation id, which Bedrock rarely serves on demand. */
function routePreference(model: ModelInfo): number {
  const id = String(model.id);
  if (model.backend !== ModelBackend.Bedrock) return 0;
  if (id.startsWith('global.')) return 0;
  return BEDROCK_PROFILE_PREFIX.test(id) ? 1 : 2;
}

function preferenceTuple(
  model: ModelInfo,
  release: string | null,
  preferredIds: ReadonlySet<string>,
  activeModelId: string
): number[] {
  const id = String(model.id);
  return [id === activeModelId ? 0 : 1, preferredIds.has(id) ? 0 : 1, routePreference(model), release ? 1 : 0];
}

// The id comparison is the last tiebreak so the winner never depends on input order.
function isPreferred(candidate: Preference, incumbent: Preference): boolean {
  for (let i = 0; i < candidate.tuple.length; i++) {
    if (candidate.tuple[i] !== incumbent.tuple[i]) return candidate.tuple[i] < incumbent.tuple[i];
  }
  return String(candidate.model.id) < String(incumbent.model.id);
}

/**
 * One enabled row per release, in input order. An alias joins a release only when it is that
 * base's sole release; with two or more it stays its own row. A disabled active model is also kept
 * so the user can see their current selection and switch to an enabled twin.
 *
 * `preferredIds` (Recommended and Favorites) win their group unless the active model is enabled.
 * Disabled favorites and recommendations are hidden like other unavailable models.
 */
export function dedupeModelsForPicker(
  models: ModelInfo[],
  preferredIds: ReadonlySet<string>,
  activeModelId: string
): ModelInfo[] {
  const enabled = models.filter(model => !model.disabled).map(model => ({ model, ...parseModelId(model) }));

  const releasesByBase = new Map<string, Set<string>>();
  for (const { base, release } of enabled) {
    if (!release) continue;
    releasesByBase.set(base, (releasesByBase.get(base) ?? new Set<string>()).add(release));
  }

  const winners = new Map<string, Preference>();
  for (const { model, base, release } of enabled) {
    const releases = releasesByBase.get(base);
    const soleRelease = releases?.size === 1 ? [...releases][0] : null;
    const resolvedRelease = release ?? soleRelease;
    const key = resolvedRelease ? `${base}@${resolvedRelease}` : base;
    const candidate = { model, tuple: preferenceTuple(model, release, preferredIds, activeModelId) };
    const incumbent = winners.get(key);
    if (!incumbent || isPreferred(candidate, incumbent)) winners.set(key, candidate);
  }

  const kept = new Set(Array.from(winners.values(), winner => winner.model));
  return models.filter(model => kept.has(model) || (model.disabled && String(model.id) === activeModelId));
}
