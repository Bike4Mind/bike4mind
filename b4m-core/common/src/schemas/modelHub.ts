import { z } from 'zod';

// Bounds keep a hostile remote manifest from making clients allocate or loop without limit.
const MAX_LAYERS = 1024;
const MAX_CONTEXT = 2 ** 24;
const MAX_BYTES = 2 ** 50;
const MAX_ENTRIES = 500;
const MAX_FAMILIES = 200;
const MAX_BUILDS = 16;
const MAX_CHANGELOG = 200;
const MAX_TIERS = 32;
const MAX_SEQUENCE = 2 ** 31;

// The manifest is fetched remotely and its links are opened externally, so every URL is https on a public host
// name, and every repo path or ref is restricted to a charset that cannot traverse or inject.
function isPublicHttpsUrl(value: string): boolean {
  if (value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const { hostname } = url;
  return (
    /^(?:[a-z0-9-]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(hostname) &&
    !/\.(?:localhost|local|internal)$/.test(hostname)
  );
}

const HttpsUrlSchema = z.string().max(2048).refine(isPublicHttpsUrl, 'Invalid URL');
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const ByteCountSchema = z.number().int().positive().max(MAX_BYTES);
const SlugSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const HfRepoSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/);
// One optional subdir for split ladders (UD-Q4_K_XL/) and sidecars (MTP/); no segment starts with a dot or dash.
const RepoPathSchema = z
  .string()
  .max(200)
  .regex(/^(?:\w[\w.-]*\/)?\w[\w.-]*\.gguf$/);
const OllamaLibRefSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*:[a-z0-9][\w.-]*$/);
// Ollama renderer/parser ids such as qwen3.5, gemma4 or nemotron-3.5-nano.
const OllamaNameSchema = z
  .string()
  .max(32)
  .regex(/^[a-z0-9][a-z0-9.-]*$/);
const SemverSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const RuntimeVersionSchema = z.string().min(1).max(32);
const CountSchema = z.number().int().nonnegative().max(1e6);
const TotalSchema = z.number().int().positive().max(1e6);
const RateSchema = z.number().positive().max(1e6);
const LayerCountSchema = z.number().int().nonnegative().max(MAX_LAYERS);
const ContextSchema = z.number().int().positive().max(MAX_CONTEXT);

export const HUB_ROLES = ['chat', 'code', 'vision', 'embeddings'] as const;
export const HubRoleSchema = z.enum(HUB_ROLES);
export type HubRole = z.infer<typeof HubRoleSchema>;

export const HUB_RUNTIMES = ['ollama', 'llama-server'] as const;
export const HubRuntimeSchema = z.enum(HUB_RUNTIMES);
export type HubRuntime = z.infer<typeof HubRuntimeSchema>;

export const VARIANT_TYPES = [
  'official',
  'requant',
  'fine-tune',
  'merge',
  'abliterated',
  'distill',
  'expert-pruned',
] as const;
export const PRODUCER_TIERS = ['A', 'B', 'C'] as const;
export type ProducerTier = (typeof PRODUCER_TIERS)[number];
// Ordered least to most restrictive.
export const LICENSE_CLASSES = ['permissive', 'restricted-commercial', 'research', 'non-commercial'] as const;
export const KV_CACHE_TYPES = ['f16', 'q8_0', 'q4_0'] as const;
export type KvCacheType = (typeof KV_CACHE_TYPES)[number];
// Recurrent layer types the fit estimator has measured: Mamba2 in Granite 4 H, gated delta net in Qwen3.5.
export const RECURRENT_KINDS = ['mamba2', 'gated-delta-net'] as const;
export type RecurrentKind = (typeof RECURRENT_KINDS)[number];
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const;
export const ROUTE_REASONS = [
  'library-tag',
  'renderer-known',
  'sharded',
  'no-ollama-renderer',
  'expert-offload',
  'per-model-kv',
  'lazy-mode',
  'draft-sidecar',
  'template-override',
] as const;
export const EVIDENCE_KINDS = ['kld', 'ppl', 'benchmark', 'tool-eval', 'own-eval', 'speed'] as const;
export const SMOKE_CHECKS = ['acquire', 'show', 'load', 'plain', 'think', 'tool', 'image', 'draft'] as const;
// Ordered best to worst.
export const EVIDENCE_GRADES = ['A', 'B', 'C', 'D'] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

const AttnGroupSchema = z.object({
  layers: LayerCountSchema,
  kvHeads: z.number().int().positive().max(1024),
  keyLength: z.number().int().positive().max(4096),
  valueLength: z.number().int().positive().max(4096),
});

/**
 * Per-layer-type shape that drives KV and state memory. `@bike4mind/local-models` extracts the same shape
 * from GGUF headers and `/api/show`; keep the two in sync.
 */
export const ModelArchSchema = z.object({
  contextMax: ContextSchema,
  blockCount: z.number().int().positive().max(MAX_LAYERS),
  // Query heads of the attention layers, the largest if they vary; only prices flash attention off.
  headCount: z.number().int().positive().max(4096).optional(),
  // Compute widths: n_embd, and the widest FFN a token passes through (n_ff, or used x expert width plus shared
  // experts). Without them the estimator bounds compute from the weights.
  embeddingLength: z.number().int().positive().max(65536).optional(),
  activeFeedForwardLength: z.number().int().positive().max(1048576).optional(),
  full: AttnGroupSchema,
  // llama.cpp reports n_swa 0 for some families (gemma2, gpt-oss, cohere2) and still keeps ubatch cells per layer.
  swa: AttnGroupSchema.extend({ window: z.number().int().nonnegative().max(MAX_CONTEXT) }).optional(),
  mla: z
    .object({
      layers: LayerCountSchema.positive(),
      kvLoraRank: z.number().int().positive().max(16384),
      ropeDim: z.number().int().positive().max(4096),
    })
    .optional(),
  // State is F32 and independent of context. A `kind` outside RECURRENT_KINDS parses, so older clients keep the
  // entry, and plans compute at the flat uncalibrated rate.
  recurrent: z
    .object({
      layers: LayerCountSchema.positive(),
      stateBytesPerSeq: ByteCountSchema,
      kind: z.string().min(1).max(32).optional(),
    })
    .optional(),
  mtpLayers: LayerCountSchema.default(0),
  moe: z
    .object({
      experts: z.number().int().positive().max(4096),
      used: z.number().int().positive().max(4096),
      moeLayers: LayerCountSchema.positive(),
    })
    .optional(),
  // Sparse-attention families are not modelled by hand; their KV size comes from a runtime probe at the default
  // f16 cache, so it overstates a quantized one.
  kvProbe: z
    .object({
      bytesPerToken: z
        .number()
        .positive()
        .max(2 ** 24),
      fixedBytes: z.number().nonnegative().max(MAX_BYTES),
      source: z.literal('llama-fit-params'),
      runtime: RuntimeVersionSchema,
    })
    .optional(),
});
export type ModelArch = z.infer<typeof ModelArchSchema>;

// sha256 is the Hugging Face lfs.oid of the file.
const GgufFileSchema = z.object({ path: RepoPathSchema, sizeBytes: ByteCountSchema, sha256: Sha256Schema });

const QuantSchema = z.object({
  label: z.string().regex(/^[A-Za-z0-9_.-]{2,40}$/),
  family: z.enum(['K', 'IQ', 'legacy', 'MXFP4', 'NVFP4', 'float', 'custom']),
  scheme: z.enum(['standard', 'imatrix', 'unsloth-dynamic', 'gsq-rco', 'byteshape', 'neo-imatrix', 'custom']),
  bpw: z.number().positive().max(32),
});

const DraftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mtp-embedded'), layers: z.number().int().positive().max(16) }),
  z.object({ kind: z.enum(['mtp-sidecar', 'dflash', 'eagle3']), file: GgufFileSchema }),
]);

const ModelfileOverrideSchema = z.object({
  renderer: OllamaNameSchema.optional(),
  parser: OllamaNameSchema.optional(),
  // A hub-bundled template id, never inline template text.
  templateRef: SlugSchema.optional(),
  dropStops: z.array(z.string().min(1).max(32)).max(8).default([]),
  draftNumPredict: z.number().int().min(1).max(16).optional(),
});

// Every layer the registry serves beside the weights; a client pulls only while it serves exactly these. hf.co
// builds template and params from the repo's main branch, so they can change without the GGUF changing. numCtx is the
// params layer's num_ctx. installedTemplate is the sha256 of the template /api/show reports once installed, needed
// when no template layer is served (Ollama then shows the GGUF's own template or its renderer's placeholder).
const OllamaLayersSchema = z
  .object({
    template: Sha256Schema.nullable(),
    params: Sha256Schema.nullable(),
    license: Sha256Schema.nullable(),
    numCtx: ContextSchema.nullable(),
    projector: Sha256Schema.nullable().default(null),
    draft: Sha256Schema.nullable().default(null),
    installedTemplate: Sha256Schema.optional(),
  })
  .refine(layers => layers.params !== null || layers.numCtx === null, { message: 'numCtx needs a params layer' });

const OllamaSourceSchema = z.discriminatedUnion('kind', [
  // sizeBytes includes the projector and any draft layer; digest is the model layer digest.
  z.object({
    kind: z.literal('library'),
    ref: OllamaLibRefSchema,
    sizeBytes: ByteCountSchema,
    digest: Sha256Schema,
    layers: OllamaLayersSchema.optional(),
  }),
  // Single-file HF GGUF; the hf.co ref is derived from the build, never stored.
  z.object({ kind: z.literal('hf-pull'), modelfile: ModelfileOverrideSchema, layers: OllamaLayersSchema.optional() }),
  // Split GGUF or separate mmproj: the hub downloads, then runs `ollama create` with one FROM per file.
  z.object({ kind: z.literal('create'), modelfile: ModelfileOverrideSchema }),
]);

const KvPairSchema = z.object({ k: z.enum(KV_CACHE_TYPES), v: z.enum(KV_CACHE_TYPES) });

// Typed fields only, each mapped to one flag by the client: the manifest is remote, so it never carries argv.
// Unknown keys are stripped so a newer manifest still parses.
const LlamaServerPresetSchema = z.object({
  kv: z.union([z.literal('auto'), KvPairSchema]).default('auto'),
  flashAttn: z.enum(['auto', 'on', 'off']).default('auto'),
  ubatch: z.number().int().min(64).max(8192).default(512),
  batch: z.number().int().min(64).max(8192).default(2048),
  nCpuMoe: z.union([z.literal('auto'), LayerCountSchema]).default('auto'),
  // llama-server defaults to 4 slots, which multiplies SWA and recurrent memory.
  slots: z.literal(1).default(1),
  speculative: z
    .object({
      type: z.enum(['none', 'draft-mtp', 'dflash', 'eagle3']),
      draftMax: z.number().int().min(1).max(16),
    })
    .default({ type: 'none', draftMax: 3 }),
  lazyMode: z.enum(['auto', 'on', 'off']).default('auto'),
  loadMmproj: z.enum(['vision-only', 'always', 'never']).default('vision-only'),
  chatTemplateRef: SlugSchema.optional(),
  ctxCap: ContextSchema.optional(),
});

const RoutingSchema = z.object({
  preferred: HubRuntimeSchema,
  reasons: z.array(z.enum(ROUTE_REASONS)).max(16),
  // Usable on Ollama at f16 KV and reduced context when llama-server is unavailable.
  ollamaFallback: z.boolean(),
});

const ToolCallSchema = z.object({ exact: CountSchema, nearMiss: CountSchema, malformed: CountSchema, of: TotalSchema });

const OwnEvalSchema = z.object({
  suite: z.string().regex(/^b4m-local-v\d{1,4}$/),
  hardware: SlugSchema,
  runtime: HubRuntimeSchema,
  runtimeVersion: RuntimeVersionSchema,
  presetHash: Sha256Schema,
  context: ContextSchema,
  kv: z.enum(KV_CACHE_TYPES),
  toolCall: ToolCallSchema,
  // The parent model on the same tool-call set; a Tier C variant is listed only with this regression check.
  parentToolCall: ToolCallSchema.optional(),
  coding: z.object({ passed: CountSchema, of: TotalSchema }),
  recall: z.object({ passed: CountSchema, of: TotalSchema }),
  decodeTokS: RateSchema,
  prefillTokS: RateSchema,
  peakBytes: ByteCountSchema,
  estimateBytes: ByteCountSchema,
  thinkingTokensMedian: CountSchema,
  refusals: z.object({ n: CountSchema, of: TotalSchema }).optional(),
});
export type HubOwnEval = z.infer<typeof OwnEvalSchema>;

const EvidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  source: HttpsUrlSchema,
  metric: z.string().min(1).max(80),
  value: z.number().min(-1e12).max(1e12),
  measured: z.object({
    // sibling: same producer and base, another quant.
    target: z.enum(['exact', 'sibling', 'base']),
    sha256: Sha256Schema.optional(),
    file: z.string().max(200).optional(),
    runtime: z.string().max(40).optional(),
  }),
  independent: z.boolean(),
  // Public method or harness.
  reproducible: z.boolean(),
  samples: z.object({ n: TotalSchema, seeds: TotalSchema.optional() }).optional(),
  date: z.iso.date(),
  ownEval: OwnEvalSchema.optional(),
});
export type HubEvidence = z.infer<typeof EvidenceSchema>;

const SmokeSchema = z.object({
  runtime: HubRuntimeSchema,
  runtimeVersion: RuntimeVersionSchema,
  date: z.iso.date(),
  pass: z.boolean(),
  checks: z.array(z.enum(SMOKE_CHECKS)).max(16),
  // KV type of the load check; lets the estimator offer a quantized cache under flash attention 'auto'.
  kv: z.enum(KV_CACHE_TYPES).optional(),
});

const BuildSchema = z.object({
  id: SlugSchema,
  // Pinned because community repos force-push. An Ollama library build has no Hugging Face files of its own.
  hf: z.object({ repo: HfRepoSchema, revision: CommitShaSchema }).optional(),
  quant: QuantSchema,
  // Shards in order.
  weights: z.array(GgufFileSchema).max(64).default([]),
  // Hugging Face weight sizes exclude the projector.
  mmproj: GgufFileSchema.optional(),
  draft: DraftSchema.optional(),
  tensorStats: z.object({ expertBytesPerLayer: ByteCountSchema, nonExpertBytes: ByteCountSchema }).optional(),
  ollama: OllamaSourceSchema.optional(),
  runtimeMin: z
    .object({ ollama: SemverSchema.optional(), llamaCppBuild: z.number().int().positive().max(1e6).optional() })
    .optional(),
  routing: RoutingSchema,
  preset: LlamaServerPresetSchema.prefault({}),
  smoke: z.array(SmokeSchema).max(32),
  evidence: z.array(EvidenceSchema).max(32),
});
export type HubBuild = z.infer<typeof BuildSchema>;

const LicenseRefSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9.+-]{2,64}$/),
  spdx: z.boolean(),
  class: z.enum(LICENSE_CLASSES),
  // The LICENSE file at the pinned revision, not the card tag.
  source: HttpsUrlSchema,
});

const LicenseSchema = LicenseRefSchema.extend({
  base: LicenseRefSchema,
  cardTag: z.string().max(64).nullable(),
  gated: z.boolean(),
  // Download asks the user to accept the license, showing `summary` and linking `source`.
  requiresAck: z.boolean().default(false),
  summary: z.string().min(1).max(160).optional(),
  legal: z.enum(['cleared', 'pending', 'blocked']),
  legalNote: z.string().max(280).optional(),
});
export type HubLicense = z.infer<typeof LicenseSchema>;

const LineageSchema = z.object({
  base: HfRepoSchema,
  variantType: z.enum(VARIANT_TYPES),
  steps: z
    .array(z.enum(['cpt', 'sft', 'rl', 'opd', 'distill', 'merge', 'abliterate', 'transplant', 'prune', 'requant']))
    .max(16)
    .default([]),
  // Merge inputs and transplant donors.
  parents: z.array(HfRepoSchema).max(8).default([]),
  producer: z.object({ name: z.string().regex(/^[\w.-]{1,64}$/), tier: z.enum(PRODUCER_TIERS) }),
});

const SamplingSchema = z.object({
  temperature: z.number().min(0).max(2),
  top_p: z.number().gt(0).max(1),
  top_k: z.number().int().positive().max(1000).optional(),
  min_p: z.number().min(0).max(1).default(0),
  presence_penalty: z.number().min(0).max(2).default(0),
  repeat_penalty: z.literal(1).default(1),
});

const ReasoningSchema = z.discriminatedUnion('via', [
  z.object({
    via: z.literal('kwarg'),
    key: z.enum(['reasoning_effort', 'enable_thinking']),
    levels: z.partialRecord(z.enum(REASONING_EFFORTS), z.union([z.string().max(16), z.boolean()])),
  }),
  z.object({ via: z.literal('system-prompt'), levels: z.partialRecord(z.enum(REASONING_EFFORTS), z.string().max(64)) }),
  z.object({ via: z.literal('none') }),
]);

const FamilySchema = z.object({
  // general.architecture in the GGUF header.
  ggufArch: z
    .string()
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
  sampling: z.object({ thinking: SamplingSchema.optional(), nonThinking: SamplingSchema.optional() }),
  reasoning: ReasoningSchema,
  ollama: z.object({ renderer: OllamaNameSchema.optional(), parser: OllamaNameSchema.optional() }),
  templateRef: SlugSchema.optional(),
  source: HttpsUrlSchema,
});
export type HubFamily = z.infer<typeof FamilySchema>;

export const TOOL_USE_RATINGS = ['unrated', 'weak', 'ok', 'strong'] as const;
const ToolUseSchema = z.object({ rating: z.enum(TOOL_USE_RATINGS), note: z.string().min(1).max(200).optional() });
export type HubToolUse = z.infer<typeof ToolUseSchema>;

const EntryHeaderSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(80),
  // Key into manifest.families.
  family: SlugSchema,
  roles: z.array(HubRoleSchema).min(1).max(8),
  why: z.string().min(1).max(140),
  lineage: LineageSchema,
  license: LicenseSchema,
  params: z.object({
    totalB: z.number().positive().max(100000),
    activeB: z.number().positive().max(100000).nullable(),
  }),
  arch: ModelArchSchema,
  // What the model supports, as its chat template and Ollama's reported capabilities say. Our evals never gate it.
  capabilities: z.object({ tools: z.boolean(), vision: z.boolean(), thinking: z.boolean(), embeddings: z.boolean() }),
  // How well it calls tools in our evals: shown to the user as information, never used to withhold tools.
  toolUse: ToolUseSchema.default({ rating: 'unrated' }),
  flags: z.object({
    abliterated: z.boolean(),
    experimental: z.boolean(),
    licenseMismatch: z.boolean(),
    customQuant: z.boolean(),
  }),
  reviewedAt: z.iso.date(),
  notesUrl: HttpsUrlSchema.nullable().optional(),
});
type EntryHeader = z.infer<typeof EntryHeaderSchema>;

const EntryObjectSchema = EntryHeaderSchema.extend({
  // Preference order.
  builds: z.array(BuildSchema).min(1).max(MAX_BUILDS),
});
type EntryShape = z.infer<typeof EntryObjectSchema>;

interface EntryIssue {
  path: PropertyKey[];
  message: string;
}

const licenseRank = (c: (typeof LICENSE_CLASSES)[number]) => LICENSE_CLASSES.indexOf(c);

function headerIssues(entry: EntryHeader): EntryIssue[] {
  const issues: EntryIssue[] = [];
  const issue = (path: PropertyKey[], message: string) => issues.push({ path, message });
  const { roles, capabilities, arch, flags, license, lineage } = entry;

  if (new Set(roles).size !== roles.length) issue(['roles'], 'roles must be unique');
  if (roles.includes('vision') !== capabilities.vision) {
    issue(['roles'], 'vision role and capabilities.vision must agree');
  }
  if (roles.includes('embeddings') !== capabilities.embeddings) {
    issue(['roles'], 'embeddings role and capabilities.embeddings must agree');
  }
  if (!capabilities.tools && entry.toolUse.rating !== 'unrated') {
    issue(['toolUse', 'rating'], 'a tool-use rating needs capabilities.tools');
  }
  if (entry.params.activeB !== null && entry.params.activeB > entry.params.totalB) {
    issue(['params', 'activeB'], 'activeB cannot exceed totalB');
  }

  const layered = arch.full.layers + (arch.swa?.layers ?? 0) + (arch.mla?.layers ?? 0) + (arch.recurrent?.layers ?? 0);
  if (layered > arch.blockCount) issue(['arch'], 'layer groups exceed blockCount');
  if (arch.moe && arch.moe.used > arch.moe.experts) issue(['arch', 'moe', 'used'], 'used exceeds experts');
  if (arch.moe && arch.moe.moeLayers > arch.blockCount) issue(['arch', 'moe', 'moeLayers'], 'exceeds blockCount');

  if (lineage.variantType === 'abliterated' || lineage.steps.includes('abliterate')) {
    if (!flags.abliterated) issue(['flags', 'abliterated'], 'abliterated lineage requires flags.abliterated');
  }
  if (licenseRank(license.class) < licenseRank(license.base.class)) {
    issue(['license', 'class'], 'license class cannot be less restrictive than the base license');
  }
  if (license.cardTag !== null && license.cardTag !== license.id && !flags.licenseMismatch) {
    issue(['flags', 'licenseMismatch'], 'card tag differs from the LICENSE file');
  }
  if (license.class !== 'permissive' && license.legal === 'cleared' && !license.legalNote) {
    issue(['license', 'legalNote'], 'a cleared non-permissive license needs a legalNote');
  }
  if (license.class !== 'permissive' && !license.requiresAck) {
    issue(['license', 'requiresAck'], 'a non-permissive license needs an acknowledgement');
  }
  if (license.requiresAck && !license.summary) {
    issue(['license', 'summary'], 'an acknowledged license needs a plain summary');
  }
  return issues;
}

const toolCallOverflow = (t: z.infer<typeof ToolCallSchema>) => t.exact + t.nearMiss + t.malformed > t.of;

function buildIssues(entry: EntryHeader, build: HubBuild, b: number): EntryIssue[] {
  const issues: EntryIssue[] = [];
  const at = (...rest: PropertyKey[]) => ['builds', b, ...rest];
  const issue = (path: PropertyKey[], message: string) => issues.push({ path, message });
  const { arch, capabilities, flags } = entry;

  if (build.quant.family === 'custom' && !flags.customQuant) {
    issue(['flags', 'customQuant'], 'custom quant requires flags.customQuant');
  }
  const library = build.ollama?.kind === 'library';
  if (!library && (!build.hf || build.weights.length === 0)) {
    issue(at('weights'), 'a build needs Hugging Face weights unless it is an Ollama library build');
  }
  const servedProjector = build.ollama?.kind === 'hf-pull' && !!build.ollama.layers?.projector;
  if (capabilities.vision && !build.mmproj && !library && !servedProjector) {
    issue(at('mmproj'), 'a vision build needs an mmproj, a pinned projector layer or an Ollama library source');
  }
  if (build.weights.length > 1) {
    if (!build.routing.reasons.includes('sharded')) issue(at('routing', 'reasons'), 'sharded weights need sharded');
    if (build.ollama && build.ollama.kind !== 'create') {
      issue(at('ollama', 'kind'), 'Ollama cannot pull shards; use create');
    }
  }
  if (build.ollama?.kind === 'hf-pull' && (build.weights.length > 1 || build.mmproj)) {
    issue(at('ollama', 'kind'), 'hf-pull needs a single file and no separate mmproj; use create');
  }
  if ((build.routing.preferred === 'ollama' || build.routing.ollamaFallback) && !build.ollama) {
    issue(at('ollama'), 'routing to Ollama needs an Ollama source');
  }
  if (build.tensorStats && !arch.moe) issue(at('tensorStats'), 'tensorStats needs arch.moe');
  if (build.tensorStats && arch.moe) {
    const { expertBytesPerLayer, nonExpertBytes } = build.tensorStats;
    const weightBytes = build.weights.reduce((sum, w) => sum + w.sizeBytes, 0);
    // An inflated expert size would let the fit estimator offload too few layers.
    if (expertBytesPerLayer * arch.moe.moeLayers + nonExpertBytes > weightBytes) {
      issue(at('tensorStats'), 'tensorStats exceed the weight files');
    }
  }
  const { nCpuMoe } = build.preset;
  if (typeof nCpuMoe === 'number' && nCpuMoe > (arch.moe?.moeLayers ?? 0)) {
    issue(at('preset', 'nCpuMoe'), 'nCpuMoe exceeds the MoE layer count');
  }
  if (typeof nCpuMoe === 'number' && nCpuMoe > 0 && !build.tensorStats) {
    issue(at('preset', 'nCpuMoe'), 'a fixed nCpuMoe needs tensorStats');
  }

  const spec = build.preset.speculative.type;
  const draftKind = build.draft?.kind;
  const draftOk =
    spec === 'none' ||
    (spec === 'draft-mtp' && (draftKind === 'mtp-embedded' || draftKind === 'mtp-sidecar')) ||
    spec === draftKind;
  if (!draftOk) issue(at('preset', 'speculative', 'type'), `speculative ${spec} needs a matching draft`);
  const kv = build.preset.kv;
  if (kv !== 'auto' && kv.v !== 'f16' && build.preset.flashAttn !== 'on') {
    issue(at('preset', 'kv'), "a quantized V cache requires flashAttn 'on'");
  }
  if (kv !== 'auto' && arch.kvProbe && (kv.k !== 'f16' || kv.v !== 'f16')) {
    issue(at('preset', 'kv'), 'a kvProbe arch is sized at f16 KV only');
  }

  const ownDigests = new Set(build.weights.map(w => w.sha256));
  if (build.ollama?.kind === 'library') ownDigests.add(build.ollama.digest);
  build.evidence.forEach((ev, e) => {
    const evAt = (...rest: PropertyKey[]) => at('evidence', e, ...rest);
    if (ev.measured.target === 'exact' && !(ev.measured.sha256 && ownDigests.has(ev.measured.sha256))) {
      issue(evAt('measured', 'sha256'), 'exact evidence must name a weight or Ollama digest of this build');
    }
    if ((ev.kind === 'own-eval') !== (ev.ownEval !== undefined)) {
      issue(evAt('ownEval'), 'ownEval is required for, and only for, kind own-eval');
    }
    const own = ev.ownEval;
    if (!own) return;
    if (!ev.independent || !ev.reproducible || ev.measured.target !== 'exact') {
      issue(evAt('measured'), 'an own eval is independent, reproducible and on the exact build');
    }
    if (toolCallOverflow(own.toolCall)) issue(evAt('ownEval', 'toolCall'), 'tool-call counts exceed of');
    if (own.parentToolCall && toolCallOverflow(own.parentToolCall)) {
      issue(evAt('ownEval', 'parentToolCall'), 'tool-call counts exceed of');
    }
    if (own.coding.passed > own.coding.of) issue(evAt('ownEval', 'coding'), 'passed exceeds of');
    if (own.recall.passed > own.recall.of) issue(evAt('ownEval', 'recall'), 'passed exceeds of');
    if (own.refusals && own.refusals.n > own.refusals.of) issue(evAt('ownEval', 'refusals'), 'n exceeds of');
  });
  return issues;
}

function refineEntry(entry: EntryShape, ctx: z.RefinementCtx<EntryShape>): void {
  const issues = headerIssues(entry);
  const buildIds = new Set<string>();
  entry.builds.forEach((build, b) => {
    if (buildIds.has(build.id)) issues.push({ path: ['builds', b, 'id'], message: `duplicate build id ${build.id}` });
    buildIds.add(build.id);
    issues.push(...buildIssues(entry, build, b));
  });
  for (const { path, message } of issues) ctx.addIssue({ code: 'custom', path, message });
}

export const HubEntrySchema = EntryObjectSchema.superRefine(refineEntry);
export type HubEntry = z.infer<typeof HubEntrySchema>;

export const ABLITERATED_POLICIES = ['hidden', 'explore-only', 'curated-opt-in'] as const;
export const RESTRICTED_LICENSE_POLICIES = ['hidden', 'explore-only', 'curated-labelled'] as const;

// Owner decisions as data: changing one is a manifest change, not a client release. 'curated-opt-in' means the
// user's "Show abliterated models" toggle (off by default) shows them in Curated and Explore; never a best pick.
export const HubPolicySchema = z.object({
  abliterated: z.enum(ABLITERATED_POLICIES).default('curated-opt-in'),
  restrictedLicense: z.enum(RESTRICTED_LICENSE_POLICIES).default('curated-labelled'),
  bestPickPermissiveOnly: z.boolean().default(false),
  minGradeForBestPick: z.enum(EVIDENCE_GRADES).default('B'),
});
export type HubPolicy = z.infer<typeof HubPolicySchema>;

const maxKeys = (n: number) => (record: Record<string, unknown>) => Object.keys(record).length <= n;

const SlugListSchema = z.array(SlugSchema).max(50);
// Newest first; `removed` carries the name because the entry is gone.
const ChangelogItemSchema = z.object({
  sequence: z.number().int().min(1).max(MAX_SEQUENCE),
  date: z.iso.date(),
  added: SlugListSchema,
  removed: z.array(z.object({ id: SlugSchema, name: z.string().min(1).max(80) })).max(50),
  changed: SlugListSchema,
  notes: z.string().max(280),
});
export type HubChangelogItem = z.infer<typeof ChangelogItemSchema>;

// The Curated tab's per-machine slots; CPU-only machines get a light pick where GPUs get a long-context one.
export const CURATED_SLOTS = ['best', 'fast', 'long-context', 'light'] as const;
export type CuratedSlot = (typeof CURATED_SLOTS)[number];
const TierPickSchema = z.object({ slot: z.enum(CURATED_SLOTS), entry: SlugSchema, build: SlugSchema });
// minGiB is GPU memory on a discrete machine and total memory otherwise, in the GiB the hardware is sold with.
const TierSchema = z.object({
  memoryKind: z.enum(['discrete', 'unified', 'cpu']),
  minGiB: z.number().int().nonnegative().max(65536),
  picks: z.array(TierPickSchema).max(CURATED_SLOTS.length),
});
export type HubTier = z.infer<typeof TierSchema>;
export type HubTierPick = z.infer<typeof TierPickSchema>;

function pickIssue(pick: HubTierPick, entries: readonly HubEntry[]): string | null {
  const entry = entries.find(candidate => candidate.id === pick.entry);
  if (!entry) return `no entry ${pick.entry}`;
  return entry.builds.some(build => build.id === pick.build) ? null : `no build ${pick.build} in ${pick.entry}`;
}

const ManifestObjectSchema = z.object({
  schemaVersion: z.literal(2),
  // Strictly increases on every published change; the only ordering key between two lists.
  sequence: z.number().int().min(1).max(MAX_SEQUENCE).optional(),
  // Also the date the Curated tab shows for the list.
  updatedAt: z.iso.datetime(),
  notesUrl: HttpsUrlSchema.nullable().optional(),
  changelog: z.array(ChangelogItemSchema).max(MAX_CHANGELOG).default([]),
  policy: HubPolicySchema.prefault({}),
  families: z.record(SlugSchema, FamilySchema).refine(maxKeys(MAX_FAMILIES), 'too many families'),
  // Per role, best first.
  rankings: z.partialRecord(HubRoleSchema, z.array(SlugSchema).max(MAX_ENTRIES)),
  tiers: z.array(TierSchema).max(MAX_TIERS).default([]),
  entries: z.array(HubEntrySchema).max(MAX_ENTRIES),
});
type ManifestShape = z.infer<typeof ManifestObjectSchema>;

function refineManifest(manifest: ManifestShape, ctx: z.RefinementCtx<ManifestShape>): void {
  manifest.tiers.forEach((tier, t) => {
    const issue = (path: PropertyKey[], message: string) =>
      ctx.addIssue({ code: 'custom', path: ['tiers', t, ...path], message });
    if (manifest.tiers.slice(0, t).some(o => o.memoryKind === tier.memoryKind && o.minGiB === tier.minGiB))
      issue([], 'duplicate tier');
    tier.picks.forEach((pick, p) => {
      const reason = pickIssue(pick, manifest.entries);
      if (reason) issue(['picks', p], reason);
      if (tier.picks.slice(0, p).some(other => other.slot === pick.slot)) issue(['picks', p, 'slot'], 'slot taken');
    });
  });
  const byId = new Map<string, HubEntry>();
  manifest.entries.forEach((entry, i) => {
    if (byId.has(entry.id)) {
      ctx.addIssue({ code: 'custom', path: ['entries', i, 'id'], message: `duplicate entry id ${entry.id}` });
    }
    byId.set(entry.id, entry);
    if (!Object.hasOwn(manifest.families, entry.family)) {
      ctx.addIssue({ code: 'custom', path: ['entries', i, 'family'], message: `unknown family ${entry.family}` });
    }
  });
  for (const role of HUB_ROLES) {
    const ids = manifest.rankings[role] ?? [];
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['rankings', role], message: 'ranking lists an id twice' });
    }
    ids.forEach((id, i) => {
      const entry = byId.get(id);
      if (!entry || !entry.roles.includes(role)) {
        ctx.addIssue({ code: 'custom', path: ['rankings', role, i], message: `no ${role} entry ${id}` });
      }
    });
  }
}

/** Curated local-model manifest for the Model Hub, validated whole; the catalog's own CI uses this. */
export const HubManifestSchema = ManifestObjectSchema.superRefine(refineManifest);
export type HubManifest = z.infer<typeof HubManifestSchema>;
export type HubManifestInput = z.input<typeof HubManifestSchema>;

/** Something a client skipped while reading a newer or partly invalid manifest. */
export interface HubManifestDrop {
  path: string;
  reason: string;
}

export interface HubManifestParse {
  manifest: HubManifest;
  dropped: HubManifestDrop[];
}

// Policy values a client does not understand fall back to the most restrictive choice.
const POLICY_FALLBACK: HubPolicy = {
  abliterated: 'hidden',
  restrictedLicense: 'hidden',
  bestPickPermissiveOnly: true,
  minGradeForBestPick: 'A',
};

const ManifestEnvelopeSchema = z.object({
  schemaVersion: z.literal(2),
  sequence: z.number().int().min(1).max(MAX_SEQUENCE).optional(),
  updatedAt: z.iso.datetime(),
  notesUrl: HttpsUrlSchema.nullable().optional(),
  changelog: z.unknown().optional(),
  tiers: z.unknown().optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
  families: z.record(z.string(), z.unknown()).refine(maxKeys(MAX_FAMILIES), 'too many families'),
  rankings: z.record(z.string(), z.unknown()).refine(maxKeys(16), 'too many rankings'),
  entries: z.array(z.unknown()).max(MAX_ENTRIES),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function knownOnly(value: unknown, known: readonly string[]): unknown {
  return Array.isArray(value) ? value.filter(v => typeof v === 'string' && known.includes(v)) : value;
}

/** The rating is a label, so a problem with it (unknown rating, rating without tools, bad note) costs only the label. */
function knownToolUse(value: unknown, capabilities: unknown): unknown {
  if (value === undefined) return value;
  if (!isRecord(value)) return { rating: 'unrated' };
  const known = (TOOL_USE_RATINGS as readonly unknown[]).includes(value.rating);
  const tools = isRecord(capabilities) && capabilities.tools === true;
  if (!known || (!tools && value.rating !== 'unrated')) return { rating: 'unrated' };
  const note = ToolUseSchema.shape.note.safeParse(value.note);
  return { rating: value.rating, ...(note.success && note.data !== undefined ? { note: note.data } : {}) };
}

const describeIssue = (issue: { path: PropertyKey[]; message: string }) =>
  issue.path.length ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message;

const firstIssue = (error: z.ZodError) => describeIssue(error.issues[0]);

class TolerantReader {
  readonly dropped: HubManifestDrop[] = [];

  drop(path: string, reason: string): void {
    this.dropped.push({ path, reason });
  }

  policy(raw: Record<string, unknown> = {}): HubPolicy {
    const field = <K extends keyof HubPolicy>(key: K): HubPolicy[K] => {
      const result = HubPolicySchema.shape[key].safeParse(raw[key]);
      if (result.success) return result.data as HubPolicy[K];
      this.drop(`policy.${key}`, firstIssue(result.error));
      return POLICY_FALLBACK[key];
    };
    return {
      abliterated: field('abliterated'),
      restrictedLicense: field('restrictedLicense'),
      bestPickPermissiveOnly: field('bestPickPermissiveOnly'),
      minGradeForBestPick: field('minGradeForBestPick'),
    };
  }

  families(raw: Record<string, unknown>): Record<string, HubFamily> {
    const families: Record<string, HubFamily> = {};
    for (const [key, value] of Object.entries(raw)) {
      const parsed = FamilySchema.safeParse(value);
      if (!SlugSchema.safeParse(key).success) this.drop(`families.${key}`, 'invalid family key');
      else if (!parsed.success) this.drop(`families.${key}`, firstIssue(parsed.error));
      else families[key] = parsed.data;
    }
    return families;
  }

  /** Keeps the valid items of a bounded list, dropping the rest; an oversized list is left for the schema. */
  private items(value: unknown, path: string, schema: z.ZodType, prepare = (v: unknown) => v): unknown {
    if (!Array.isArray(value) || value.length > 64) return value;
    return value.map(prepare).filter((item, i) => {
      const result = schema.safeParse(item);
      if (!result.success) this.drop(`${path}.${i}`, firstIssue(result.error));
      return result.success;
    });
  }

  private build(raw: unknown, path: string): HubBuild | null {
    if (!isRecord(raw)) {
      this.drop(path, 'not an object');
      return null;
    }
    const routing = isRecord(raw.routing)
      ? { ...raw.routing, reasons: knownOnly(raw.routing.reasons, ROUTE_REASONS) }
      : raw.routing;
    const smoke = this.items(raw.smoke, `${path}.smoke`, SmokeSchema, s =>
      isRecord(s) ? { ...s, checks: knownOnly(s.checks, SMOKE_CHECKS) } : s
    );
    const evidence = this.items(raw.evidence, `${path}.evidence`, EvidenceSchema);
    const parsed = BuildSchema.safeParse({ ...raw, routing, smoke, evidence });
    if (!parsed.success) {
      this.drop(path, firstIssue(parsed.error));
      return null;
    }
    return parsed.data;
  }

  entry(raw: unknown, path: string, families: Record<string, HubFamily>): HubEntry | null {
    if (!isRecord(raw)) {
      this.drop(path, 'not an object');
      return null;
    }
    const header = EntryHeaderSchema.safeParse({
      ...raw,
      roles: knownOnly(raw.roles, HUB_ROLES),
      toolUse: knownToolUse(raw.toolUse, raw.capabilities),
    });
    if (!header.success) {
      this.drop(path, firstIssue(header.error));
      return null;
    }
    const problems = headerIssues(header.data);
    if (!Object.hasOwn(families, header.data.family)) problems.push({ path: ['family'], message: 'unknown family' });
    if (problems.length) {
      this.drop(path, describeIssue(problems[0]));
      return null;
    }
    const rawBuilds = Array.isArray(raw.builds) && raw.builds.length <= MAX_BUILDS ? raw.builds : [];
    const builds: HubBuild[] = [];
    rawBuilds.forEach((rawBuild, b) => {
      const buildPath = `${path}.builds.${b}`;
      const build = this.build(rawBuild, buildPath);
      if (!build) return;
      const issues = buildIssues(header.data, build, b);
      if (builds.some(other => other.id === build.id)) issues.push({ path: ['id'], message: 'duplicate build id' });
      if (issues.length) this.drop(buildPath, describeIssue(issues[0]));
      else builds.push(build);
    });
    if (builds.length === 0) {
      this.drop(path, 'no usable builds');
      return null;
    }
    return { ...header.data, builds };
  }

  changelog(raw: unknown): HubChangelogItem[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_CHANGELOG) {
      this.drop('changelog', 'not a list of at most 200 items');
      return [];
    }
    return raw.flatMap((item, i) => {
      const parsed = ChangelogItemSchema.safeParse(item);
      if (parsed.success) return [parsed.data];
      this.drop(`changelog.${i}`, firstIssue(parsed.error));
      return [];
    });
  }

  /** A pick whose entry or build was dropped leaves its slot empty; no other pick moves into it. */
  tiers(raw: unknown, entries: HubEntry[]): HubTier[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_TIERS) {
      this.drop('tiers', 'not a list of at most 32 tiers');
      return [];
    }
    const tiers: HubTier[] = [];
    raw.forEach((rawTier, t) => {
      const path = `tiers.${t}`;
      const picks = isRecord(rawTier) ? this.items(rawTier.picks, `${path}.picks`, TierPickSchema) : undefined;
      const parsed = TierSchema.safeParse(isRecord(rawTier) ? { ...rawTier, picks } : rawTier);
      if (!parsed.success) return this.drop(path, firstIssue(parsed.error));
      const tier = parsed.data;
      if (tiers.some(other => other.memoryKind === tier.memoryKind && other.minGiB === tier.minGiB))
        return this.drop(path, 'duplicate tier');
      const kept = tier.picks.filter((pick, p) => {
        const reason =
          pickIssue(pick, entries) ?? (tier.picks.slice(0, p).some(o => o.slot === pick.slot) && 'slot taken');
        if (reason) this.drop(`${path}.picks.${p}`, reason);
        return !reason;
      });
      tiers.push({ ...tier, picks: kept });
    });
    return tiers;
  }

  rankings(raw: Record<string, unknown>, entries: HubEntry[]): HubManifest['rankings'] {
    const rankings: HubManifest['rankings'] = {};
    for (const [key, value] of Object.entries(raw)) {
      const role = HubRoleSchema.safeParse(key);
      if (!role.success || !Array.isArray(value)) {
        this.drop(`rankings.${key}`, role.success ? 'not a list' : 'unknown role');
        continue;
      }
      const ids: string[] = [];
      value.slice(0, MAX_ENTRIES).forEach((id, i) => {
        const listed = entries.some(e => e.id === id && e.roles.includes(role.data));
        if (typeof id === 'string' && listed && !ids.includes(id)) ids.push(id);
        else if (typeof id === 'string') this.drop(`rankings.${key}.${i}`, `no ${key} entry ${id.slice(0, 64)}`);
        else this.drop(`rankings.${key}.${i}`, `ranking id is not a string (${id === null ? 'null' : typeof id})`);
      });
      rankings[role.data] = ids;
    }
    return rankings;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Reads a fetched manifest the way a shipped client must: the envelope has to be valid, but an entry, build,
 * family, ranking id, smoke record or evidence item this client cannot read is dropped and reported, and unknown
 * roles, route reasons and smoke checks are ignored. Returns the manifest deep-frozen.
 */
export function parseHubManifest(input: unknown): HubManifestParse {
  const envelope = ManifestEnvelopeSchema.parse(input);
  const reader = new TolerantReader();
  const policy = reader.policy(envelope.policy);
  const families = reader.families(envelope.families);
  const entries: HubEntry[] = [];
  envelope.entries.forEach((raw, i) => {
    const entry = reader.entry(raw, `entries.${i}`, families);
    if (!entry) return;
    if (entries.some(e => e.id === entry.id)) reader.drop(`entries.${i}`, `duplicate entry id ${entry.id}`);
    else entries.push(entry);
  });
  const manifest: HubManifest = {
    schemaVersion: 2,
    ...(envelope.sequence === undefined ? {} : { sequence: envelope.sequence }),
    updatedAt: envelope.updatedAt,
    notesUrl: envelope.notesUrl,
    changelog: reader.changelog(envelope.changelog),
    policy,
    families,
    rankings: reader.rankings(envelope.rankings, entries),
    tiers: reader.tiers(envelope.tiers, entries),
    entries,
  };
  return { manifest: deepFreeze(manifest), dropped: reader.dropped };
}
