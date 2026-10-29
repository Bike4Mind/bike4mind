import type {
  HubBuild,
  HubEntry,
  HubManifest,
  HubOwnEval,
  HubRole,
  HubRuntime,
  KvCacheType,
  ProducerTier,
} from '../schemas/modelHub';
import { estimateFit, type FitMode, type FitModel, type FitResult, type FitRuntime, type HardwareProfile } from './fit';
import { entryTier, gradeBuild, isCurrentOwnEval, meetsGrade, type BuildGrade, type RuntimePins } from './grade';

/** Runtimes present on this machine. */
export interface MachineRuntimes {
  ollama?: {
    version: string;
    kvType?: KvCacheType;
    numParallel?: number;
    /** False when OLLAMA_FLASH_ATTENTION disables it; Ollama then keeps an f16 cache. */
    flashAttention?: boolean;
  };
  'llama-server'?: { build: number };
}

export interface PickOptions {
  manifest: HubManifest;
  hardware: HardwareProfile;
  role: HubRole;
  runtimes: MachineRuntimes;
  pins: RuntimePins;
  /** The user's "Show abliterated models" toggle; honoured only under policy 'curated-opt-in'. */
  showAbliterated?: boolean;
}

export type HubLabel = 'restricted-license' | 'abliterated' | 'experimental' | 'eval-pending';

export interface HubCandidate {
  entry: HubEntry;
  build: HubBuild;
  runtime: HubRuntime;
  fit: FitResult;
  grade: BuildGrade;
  tier: ProducerTier;
  labels: HubLabel[];
  /** The latest current own eval on this runtime, if any. */
  ownEval: HubOwnEval | null;
  /** Set when the download must ask the user to accept the license first. */
  licenseAck: { summary: string; source: string } | null;
}

export interface HubPick {
  best: HubCandidate | null;
  alternates: HubCandidate[];
}

// Ollama forces one slot for these architectures whatever OLLAMA_NUM_PARALLEL says.
const OLLAMA_SINGLE_SLOT_ARCHS = new Set(['qwen35', 'qwen3next', 'nemotron_h', 'lfm2']);
// Ollama 0.40.11 passes --spec-draft-n-max 2 for a model that ships a draft unless the Modelfile sets one.
const OLLAMA_DEFAULT_DRAFT_MAX = 2;

const ROLE_MODE: Record<HubRole, FitMode> = { chat: 'chat', code: 'code', vision: 'chat', embeddings: 'embeddings' };
const VERDICT_RANK: Record<FitResult['verdict'], number> = { fast: 0, tight: 1, slow: 2, 'too-large': 3 };

function semverAtLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// The newest run on the pin decides; a failure on that date outweighs a pass the same day.
function smokePassed(build: HubBuild, runtime: HubRuntime, pins: RuntimePins): boolean {
  const runs = build.smoke.filter(s => s.runtime === runtime && s.runtimeVersion === pins[runtime]);
  const newest = runs.reduce((date, s) => (s.date > date ? s.date : date), '');
  return runs.length > 0 && runs.every(s => s.date !== newest || s.pass);
}

function runtimeUsable(build: HubBuild, runtime: HubRuntime, options: PickOptions): boolean {
  const min = build.runtimeMin;
  if (!smokePassed(build, runtime, options.pins)) return false;
  if (runtime === 'ollama') {
    const ollama = options.runtimes.ollama;
    return !!ollama && !!build.ollama && (!min?.ollama || semverAtLeast(ollama.version, min.ollama));
  }
  const server = options.runtimes['llama-server'];
  return !!server && (!min?.llamaCppBuild || server.build >= min.llamaCppBuild);
}

function runtimeOrder(build: HubBuild): HubRuntime[] {
  if (build.routing.preferred === 'ollama') return ['ollama', 'llama-server'];
  return build.routing.ollamaFallback ? ['llama-server', 'ollama'] : ['llama-server'];
}

function fitInputs(entry: HubEntry, build: HubBuild, runtime: HubRuntime, options: PickOptions) {
  const weights = build.weights.reduce((sum, w) => sum + w.sizeBytes, 0);
  const expertBytesPerLayer = build.tensorStats?.expertBytesPerLayer;
  const draftFile = build.draft && 'file' in build.draft ? build.draft.file : undefined;
  if (runtime === 'ollama') {
    const ollama = options.runtimes.ollama;
    const family = options.manifest.families[entry.family];
    const source = build.ollama;
    const library = source?.kind === 'library';
    const hasDraft = build.draft !== undefined || entry.arch.mtpLayers > 0;
    const draftNumPredict = source && source.kind !== 'library' ? source.modelfile.draftNumPredict : undefined;
    // Ollama loads a model's projector whenever it has one; a library layer size already includes it.
    const model: FitModel = {
      arch: entry.arch,
      weightsBytes: library ? source.sizeBytes : weights,
      mmprojBytes: library ? 0 : (build.mmproj?.sizeBytes ?? 0),
      draftBytes: library ? 0 : (draftFile?.sizeBytes ?? 0),
      expertBytesPerLayer,
    };
    const fitRuntime: FitRuntime = {
      kind: 'ollama',
      kv: ollama?.kvType ? { k: ollama.kvType, v: ollama.kvType } : undefined,
      flashAttn: ollama?.flashAttention === false ? 'off' : 'auto',
      slots: family && OLLAMA_SINGLE_SLOT_ARCHS.has(family.ggufArch) ? 1 : (ollama?.numParallel ?? 1),
      draftMax: hasDraft ? (draftNumPredict ?? OLLAMA_DEFAULT_DRAFT_MAX) : 0,
    };
    return { model, runtime: fitRuntime, contextCap: undefined };
  }
  const { preset } = build;
  const loadMmproj =
    preset.loadMmproj === 'always' || (preset.loadMmproj === 'vision-only' && options.role === 'vision');
  const speculating = preset.speculative.type !== 'none';
  const pin = options.pins['llama-server'];
  const model: FitModel = {
    arch: entry.arch,
    weightsBytes: weights,
    mmprojBytes: loadMmproj ? (build.mmproj?.sizeBytes ?? 0) : 0,
    draftBytes: speculating && draftFile ? draftFile.sizeBytes : 0,
    expertBytesPerLayer,
  };
  const fitRuntime: FitRuntime = {
    kind: 'llama-server',
    kv: preset.kv,
    flashAttn: preset.flashAttn,
    verifiedKv: build.smoke.flatMap(s =>
      s.runtime === 'llama-server' && s.pass && s.runtimeVersion === pin && s.kv ? [s.kv] : []
    ),
    ubatch: preset.ubatch,
    slots: preset.slots,
    nCpuMoe: preset.nCpuMoe,
    draftMax: speculating ? preset.speculative.draftMax : 0,
  };
  return { model, runtime: fitRuntime, contextCap: preset.ctxCap };
}

function listedInCurated(entry: HubEntry, options: PickOptions): boolean {
  const { policy } = options.manifest;
  if (!entry.roles.includes(options.role) || entry.license.legal === 'blocked') return false;
  if (entry.flags.abliterated && !(policy.abliterated === 'curated-opt-in' && options.showAbliterated)) return false;
  return entry.license.class === 'permissive' || policy.restrictedLicense === 'curated-labelled';
}

function latestOwnEval(build: HubBuild, runtime: HubRuntime, pins: RuntimePins): HubOwnEval | null {
  const current = build.evidence.filter(e => isCurrentOwnEval(e, pins) && e.ownEval?.runtime === runtime);
  return current.sort((a, b) => b.date.localeCompare(a.date))[0]?.ownEval ?? null;
}

/** How far a Tier C variant's exact tool-call rate may fall below its parent's on the same eval run. */
export const TIER_C_TOOL_REGRESSION_TOLERANCE = 0.05;

// Tier A lists on a smoke pass; Tier B also needs a current own eval, and Tier C one whose tool calls did not
// regress against the parent model.
function meetsListingBar(tier: ProducerTier, own: HubOwnEval | null): boolean {
  if (tier === 'A') return true;
  if (own === null) return false;
  if (tier === 'B') return true;
  const parent = own.parentToolCall;
  if (!parent || own.toolCall.of <= 0 || parent.of <= 0) return false;
  // Cross-multiplied in integers, so a drop of exactly the tolerance is not lost to float rounding.
  // Assumes the tolerance is a whole percent; a finer one would be rounded here.
  const points = Math.round(TIER_C_TOOL_REGRESSION_TOLERANCE * 100);
  return 100 * own.toolCall.exact * parent.of >= (100 * parent.exact - points * parent.of) * own.toolCall.of;
}

/** The first usable runtime that meets the listing bar, preferring one with a current own eval. */
function chooseRuntime(build: HubBuild, tier: ProducerTier, options: PickOptions) {
  const listable = runtimeOrder(build)
    .filter(r => runtimeUsable(build, r, options))
    .map(runtime => ({ runtime, ownEval: latestOwnEval(build, runtime, options.pins) }))
    .filter(o => meetsListingBar(tier, o.ownEval));
  return listable.find(o => o.ownEval !== null) ?? listable[0];
}

/** Every listable build of the entry that fits this machine; custom quants stay in Explore. */
function fittingBuilds(entry: HubEntry, options: PickOptions): HubCandidate[] {
  const fits: HubCandidate[] = [];
  const tier = entryTier(entry);
  for (const build of entry.builds) {
    if (build.quant.family === 'custom' || !smokePassed(build, build.routing.preferred, options.pins)) continue;
    const chosen = chooseRuntime(build, tier, options);
    if (!chosen) continue;
    const { runtime, ownEval } = chosen;
    const inputs = fitInputs(entry, build, runtime, options);
    const fit = estimateFit({ ...inputs, hardware: options.hardware, mode: ROLE_MODE[options.role] });
    if (fit.verdict === 'too-large') continue;
    const grade = gradeBuild(entry, build, options.pins);
    const labels: HubLabel[] = [];
    if (entry.license.class !== 'permissive') labels.push('restricted-license');
    if (entry.flags.abliterated) labels.push('abliterated');
    if (entry.flags.experimental) labels.push('experimental');
    if (!ownEval) labels.push('eval-pending');
    const { requiresAck, summary, source } = entry.license;
    const licenseAck = requiresAck && summary ? { summary, source } : null;
    fits.push({ entry, build, runtime, fit, grade, tier, labels, ownEval, licenseAck });
  }
  return fits;
}

function eligibleForBest(c: HubCandidate, options: PickOptions): boolean {
  const { policy } = options.manifest;
  const { entry } = c;
  if (c.tier === 'C' || entry.flags.experimental || entry.flags.abliterated) return false;
  if (policy.bestPickPermissiveOnly && entry.license.class !== 'permissive') return false;
  return c.ownEval !== null && meetsGrade(c.grade, policy.minGradeForBestPick);
}

// A Tier B variant must beat the Tier A pick it would displace on exact tool calls with no coding regression.
function beatsTierA(c: HubCandidate, tierA: HubCandidate | undefined): boolean {
  if (!tierA) return true;
  const mine = c.ownEval;
  const theirs = tierA.ownEval;
  if (!mine || !theirs) return false;
  const rate = (n: number, of: number) => n / of;
  return (
    rate(mine.toolCall.exact, mine.toolCall.of) > rate(theirs.toolCall.exact, theirs.toolCall.of) &&
    rate(mine.coding.passed, mine.coding.of) >= rate(theirs.coding.passed, theirs.coding.of)
  );
}

/**
 * The best curated build for a role on this machine, plus one alternate per other listed entry. Candidates are
 * ordered by verdict (fast, tight, slow; a slow one below the mode floor last), then by the manifest ranking for
 * the role (unranked entries follow in manifest order), then by build preference.
 */
export function pickForMachine(options: PickOptions): HubPick {
  const { manifest, role } = options;
  const ranking = manifest.rankings[role] ?? [];
  const rankOf = (entry: HubEntry) => {
    const i = ranking.indexOf(entry.id);
    return i >= 0 ? i : ranking.length + manifest.entries.indexOf(entry);
  };
  const fitClass = (c: HubCandidate) => [VERDICT_RANK[c.fit.verdict], c.fit.context < c.fit.floor ? 1 : 0];
  const key = (c: HubCandidate) => [...fitClass(c), rankOf(c.entry), c.entry.builds.indexOf(c.build)];
  const byKey = (a: HubCandidate, b: HubCandidate) => {
    const ka = key(a);
    const kb = key(b);
    return ka.reduce((d, v, i) => d || v - kb[i], 0);
  };
  const sameClass = (a: HubCandidate, b: HubCandidate) => fitClass(a).every((v, i) => v === fitClass(b)[i]);
  const perEntry = manifest.entries
    .filter(entry => listedInCurated(entry, options))
    .map(entry => fittingBuilds(entry, options).sort(byKey))
    .filter(builds => builds.length > 0);

  const eligible = perEntry
    .flat()
    .filter(c => eligibleForBest(c, options))
    .sort(byKey);
  const best =
    eligible.find(
      c =>
        c.tier === 'A' ||
        beatsTierA(
          c,
          eligible.find(a => a.tier === 'A' && sameClass(a, c))
        )
    ) ?? null;
  const alternates = perEntry
    .filter(builds => builds[0].entry !== best?.entry)
    .map(builds => builds[0])
    .sort(byKey);
  return { best, alternates };
}
