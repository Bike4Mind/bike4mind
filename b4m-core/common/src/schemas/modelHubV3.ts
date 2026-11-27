import { z } from 'zod';
import {
  CURATED_SLOTS,
  HUB_MAX_BUILDS,
  HUB_MAX_CHANGELOG,
  HUB_MAX_ENTRIES,
  HUB_MAX_FAMILIES,
  HUB_MAX_SEQUENCE,
  HUB_MAX_TIERS,
  HUB_TIER_KINDS,
  HubBuildSchema,
  HubChangelogItemSchema,
  HubContextSchema,
  HubEntryHeaderSchema,
  HubFamilySchema,
  HubHttpsUrlSchema,
  HubLicenseRefSchema,
  HubLicenseSchema,
  HubPolicySchema,
  HubRevokedKeyIdsSchema,
  HubRoleSchema,
  HubRuntimeSchema,
  HubRuntimeVersionSchema,
  HubSlugSchema,
  HubTierSchema,
  KV_CACHE_TYPES,
  TIER_SLOTS,
  hubBuildIssues,
  hubHeaderIssues,
  hubLicenseRank,
  hubMaxKeys,
  refinePublishedCatalog,
  type HubEntryHeader,
  type HubEntryIssue,
} from './modelHub';

/** What a model produces or does; the cloud catalog's `type` values plus rerank, music and sound-effect. */
export const HUB_MODALITIES = [
  'text',
  'embedding',
  'rerank',
  'speech-to-text',
  'tts',
  'image',
  'video',
  'music',
  'sound-effect',
] as const;
export const HubModalitySchema = z.enum(HUB_MODALITIES);
export type HubModality = z.infer<typeof HubModalitySchema>;

export const HUB_SLOTS_V3 = [...CURATED_SLOTS, 'streaming', 'clone', 'edit'] as const;
export type HubSlotV3 = (typeof HUB_SLOTS_V3)[number];

/** The slots a tier may fill per modality; text is further limited per memory kind by TIER_SLOTS. */
export const MODALITY_SLOTS: Record<HubModality, readonly HubSlotV3[]> = {
  text: CURATED_SLOTS,
  embedding: ['best', 'fast'],
  rerank: ['best', 'fast'],
  'speech-to-text': ['best', 'fast', 'streaming'],
  tts: ['best', 'fast', 'clone'],
  image: ['best', 'fast', 'edit'],
  video: ['best', 'fast'],
  music: ['best'],
  'sound-effect': ['best'],
};

export const HUB_PROFILE_IDS = ['quality', 'fast'] as const;
export type HubProfileId = (typeof HUB_PROFILE_IDS)[number];

const TEXT_ROLES = ['chat', 'code', 'vision'] as const;
const MAX_PICKS = 24;
const MAX_METRICS = 16;

// Printable ASCII with no leading or trailing space: client UIs show it as is.
const DISPLAY_TEXT = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;
const LicenseLabelSchema = z.string().max(48).regex(DISPLAY_TEXT);

// Labels for well-known license ids; a v3 label for one of these ids must match, and v2 lists get it from here.
const LICENSE_LABELS = new Map<string, string>([
  ['apache-2.0', 'Apache 2.0'],
  ['mit', 'MIT'],
  ['bsd-2-clause', 'BSD 2-Clause'],
  ['bsd-3-clause', 'BSD 3-Clause'],
  ['isc', 'ISC'],
  ['gemma', 'Gemma Terms of Use'],
]);
// Folds spelling variants ("Apache-2.0", "The MIT License", "Apache License, Version 2") together so a near-miss
// label is caught too.
const labelKey = (text: string): string =>
  text
    .toLowerCase()
    .replace(/(\d)\.0\b/g, '$1')
    .replace(/\b(the|version|software)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/licen[cs]e/g, '');
const LABEL_OWNERS = new Map(
  [...LICENSE_LABELS].flatMap(([id, label]) => [
    [labelKey(label), id],
    [labelKey(id), id],
  ])
);

/** A build's own license, with the label clients show beside it. */
const BuildLicenseSchema = HubLicenseRefSchema.extend({ label: LicenseLabelSchema });
const EntryLicenseSchema = HubLicenseSchema.extend({ label: LicenseLabelSchema });

// The settings a profile was measured with. Ollama applies kv and flashAttn server-wide, so a client sets them per
// model only where the runtime allows (llama-server presets).
const TextProfileSettingsObjectSchema = z.object({
  numCtx: HubContextSchema,
  kv: z.enum(KV_CACHE_TYPES),
  flashAttn: z.enum(['on', 'auto', 'off']),
  draftNumPredict: z.number().int().min(0).max(16).optional(),
  numBatch: z.number().int().min(64).max(8192),
});
// zod reads inherited keys and copies them onto its output, so a check after parsing cannot tell; only own keys count.
const TextProfileSettingsSchema = z.preprocess<
  unknown,
  typeof TextProfileSettingsObjectSchema,
  z.input<typeof TextProfileSettingsObjectSchema>
>(
  raw => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : raw),
  TextProfileSettingsObjectSchema
);

const ProfileSchema = z.object({
  id: z.enum(HUB_PROFILE_IDS),
  settings: TextProfileSettingsSchema,
  // The results-store run these settings and metrics come from.
  evidenceRunId: z
    .string()
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/),
  measuredOn: z.object({
    date: z.iso.date(),
    hardware: HubSlugSchema,
    runtime: HubRuntimeSchema,
    runtimeVersion: HubRuntimeVersionSchema,
  }),
  // Units are in the key (TokS, MiB); z.number() already rejects NaN and Infinity. Fit checks read gpuPeakMiB.
  metrics: z
    .record(z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/), z.number().min(0).max(1e9))
    .refine(hubMaxKeys(MAX_METRICS), 'too many metrics')
    .refine(
      metrics => Object.hasOwn(metrics, 'gpuPeakMiB') && Number.isFinite(metrics.gpuPeakMiB) && metrics.gpuPeakMiB > 0,
      {
        message: 'metrics needs a positive gpuPeakMiB',
        path: ['gpuPeakMiB'],
      }
    ),
  // Conditions a reader should weigh, such as host load during the run.
  note: z.string().max(160).regex(DISPLAY_TEXT).optional(),
});
export type HubProfile = z.infer<typeof ProfileSchema>;

const BuildV3Schema = HubBuildSchema.extend({
  license: BuildLicenseSchema,
  profiles: z.array(ProfileSchema).max(HUB_PROFILE_IDS.length).default([]),
});
export type HubBuildV3 = z.infer<typeof BuildV3Schema>;

const TextEntryObjectSchema = HubEntryHeaderSchema.omit({ roles: true, capabilities: true, license: true }).extend({
  modality: z.literal('text'),
  roles: z.array(z.enum(TEXT_ROLES)).min(1).max(8),
  license: EntryLicenseSchema,
  capabilities: z.object({ tools: z.boolean(), vision: z.boolean(), thinking: z.boolean() }),
  // Preference order.
  builds: z.array(BuildV3Schema).min(1).max(HUB_MAX_BUILDS),
});
type TextEntryShape = z.infer<typeof TextEntryObjectSchema>;

/** The v2 header a text entry stands for, so v2's entry and build checks apply unchanged. */
const v2Header = (entry: TextEntryShape): HubEntryHeader => ({
  ...entry,
  capabilities: { ...entry.capabilities, embeddings: false },
});

function profileIssues(entry: TextEntryShape, build: HubBuildV3, b: number): HubEntryIssue[] {
  const issues: HubEntryIssue[] = [];
  const pins = build.ollama?.kind === 'library' || build.ollama?.kind === 'hf-pull' ? build.ollama.layers : undefined;
  const hasDraft = entry.arch.mtpLayers > 0 || build.draft !== undefined || !!pins?.draft;
  build.profiles.forEach((profile, p) => {
    const at = (...rest: PropertyKey[]) => ['builds', b, 'profiles', p, ...rest];
    const { settings } = profile;
    if (build.profiles.slice(0, p).some(other => other.id === profile.id))
      issues.push({ path: at('id'), message: `duplicate profile ${profile.id}` });
    if (settings.numCtx > entry.arch.contextMax)
      issues.push({ path: at('settings', 'numCtx'), message: 'numCtx exceeds arch.contextMax' });
    // Ollama keeps an f16 cache with flash attention off, and llama-server rejects a quantized V cache without it.
    if (settings.kv !== 'f16' && settings.flashAttn === 'off')
      issues.push({ path: at('settings', 'kv'), message: 'a quantized KV cache needs flash attention' });
    if ((settings.draftNumPredict ?? 0) > 0 && !hasDraft)
      issues.push({ path: at('settings', 'draftNumPredict'), message: 'draftNumPredict needs a draft or MTP layer' });
  });
  return issues;
}

function labelIssue(license: { id: string; label: string }, path: PropertyKey[]): HubEntryIssue[] {
  const id = license.id.toLowerCase();
  const known = LICENSE_LABELS.get(id);
  if (known !== undefined)
    return known === license.label ? [] : [{ path, message: `the label for ${license.id} is ${known}` }];
  const owner = LABEL_OWNERS.get(labelKey(license.label));
  return owner === undefined || owner === id ? [] : [{ path, message: `${license.label} reads as ${owner}` }];
}

function licenseIssues(entry: TextEntryShape, build: HubBuildV3, b: number): HubEntryIssue[] {
  const issues: HubEntryIssue[] = [...labelIssue(build.license, ['builds', b, 'license', 'label'])];
  const rank = hubLicenseRank(build.license.class);
  if (rank < hubLicenseRank(entry.license.base.class))
    issues.push({ path: ['builds', b, 'license', 'class'], message: 'less restrictive than the base license' });
  // v2 clients gate on the entry license, so it must be at least as restrictive as every build's.
  if (rank > hubLicenseRank(entry.license.class))
    issues.push({ path: ['builds', b, 'license', 'class'], message: 'more restrictive than the entry license' });
  return issues;
}

function refineTextEntry(entry: TextEntryShape, ctx: z.RefinementCtx<TextEntryShape>): void {
  const header = v2Header(entry);
  const issues = [...hubHeaderIssues(header), ...labelIssue(entry.license, ['license', 'label'])];
  const buildIds = new Set<string>();
  entry.builds.forEach((build, b) => {
    if (buildIds.has(build.id)) issues.push({ path: ['builds', b, 'id'], message: `duplicate build id ${build.id}` });
    buildIds.add(build.id);
    issues.push(
      ...hubBuildIssues(header, build, b),
      ...licenseIssues(entry, build, b),
      ...profileIssues(entry, build, b)
    );
  });
  for (const { path, message } of issues) ctx.addIssue({ code: 'custom', path, message });
}

/** A v3 entry. Only text entries exist so far; other modalities gain their capability shapes with their runtimes. */
export const HubEntryV3Schema = TextEntryObjectSchema.superRefine(refineTextEntry);
export type HubEntryV3 = z.infer<typeof HubEntryV3Schema>;

const TierPickV3Schema = z.object({
  modality: HubModalitySchema.default('text'),
  slot: z.enum(HUB_SLOTS_V3),
  entry: HubSlugSchema,
  build: HubSlugSchema,
  // The build profile the pick applies; the build's first profile when absent.
  profile: z.enum(HUB_PROFILE_IDS).optional(),
  // Context the pick is chosen for, overriding the profile's numCtx.
  numCtx: HubContextSchema.optional(),
});
export type HubTierPickV3 = z.infer<typeof TierPickV3Schema>;

const TierV3Schema = z.object({
  memoryKind: z.enum(HUB_TIER_KINDS),
  minGiB: z.number().int().nonnegative().max(65536),
  picks: z.array(TierPickV3Schema).max(MAX_PICKS),
});
export type HubTierV3 = z.infer<typeof TierV3Schema>;

/** What the curated-v2 channel publishes from this list; curatedV2FromV3 turns it into the v2 manifest. */
const V2ChannelSchema = z.object({
  sequence: z.number().int().min(1).max(HUB_MAX_SEQUENCE),
  // Per v2 sequence, sha256 of JSON.stringify(curatedV2Content(v2)); the curated:v2 script checks and records it.
  contentSha256: z
    .record(z.string().regex(/^[1-9][0-9]{0,8}$/), z.string().regex(/^[0-9a-f]{64}$/))
    .refine(hubMaxKeys(HUB_MAX_CHANGELOG), 'too many sequences'),
  updatedAt: z.iso.datetime(),
  changelog: z.array(HubChangelogItemSchema).max(HUB_MAX_CHANGELOG),
  rankings: z.partialRecord(HubRoleSchema, z.array(HubSlugSchema).max(HUB_MAX_ENTRIES)),
  tiers: z.array(HubTierSchema).max(HUB_MAX_TIERS),
  // In v2 order; each names the builds v2 lists, in order.
  entries: z
    .array(z.object({ entry: HubSlugSchema, builds: z.array(HubSlugSchema).min(1).max(HUB_MAX_BUILDS) }))
    .max(HUB_MAX_ENTRIES),
});

const ManifestV3ObjectSchema = z.object({
  schemaVersion: z.literal(3),
  sequence: z.number().int().min(1).max(HUB_MAX_SEQUENCE).optional(),
  updatedAt: z.iso.datetime(),
  notesUrl: HubHttpsUrlSchema.nullable().optional(),
  changelog: z.array(HubChangelogItemSchema).max(HUB_MAX_CHANGELOG).default([]),
  revokedKeyIds: HubRevokedKeyIdsSchema,
  policy: HubPolicySchema.prefault({}),
  families: z.record(HubSlugSchema, HubFamilySchema).refine(hubMaxKeys(HUB_MAX_FAMILIES), 'too many families'),
  // Per modality, best first.
  rankings: z.partialRecord(HubModalitySchema, z.array(HubSlugSchema).max(HUB_MAX_ENTRIES)).default({}),
  tiers: z.array(TierV3Schema).max(HUB_MAX_TIERS).default([]),
  entries: z.array(HubEntryV3Schema).max(HUB_MAX_ENTRIES),
  v2Channel: V2ChannelSchema.optional(),
});
type ManifestV3Shape = z.infer<typeof ManifestV3ObjectSchema>;

function pickV3Issue(pick: HubTierPickV3, tier: HubTierV3, byId: ReadonlyMap<string, HubEntryV3>): string | null {
  if (!MODALITY_SLOTS[pick.modality].includes(pick.slot)) return `no ${pick.slot} slot for ${pick.modality}`;
  const kindSlots: readonly string[] = TIER_SLOTS[tier.memoryKind];
  if (pick.modality === 'text' && !kindSlots.includes(pick.slot))
    return `no ${pick.slot} slot in a ${tier.memoryKind} tier`;
  const entry = byId.get(pick.entry);
  if (!entry) return `no entry ${pick.entry}`;
  if (entry.modality !== pick.modality) return `${pick.entry} is not a ${pick.modality} entry`;
  const build = entry.builds.find(candidate => candidate.id === pick.build);
  if (!build) return `no build ${pick.build} in ${pick.entry}`;
  if (pick.profile && !build.profiles.some(profile => profile.id === pick.profile))
    return `no ${pick.profile} profile on ${pick.entry}/${pick.build}`;
  if (pick.numCtx !== undefined && pick.numCtx > entry.arch.contextMax) return 'numCtx exceeds arch.contextMax';
  return null;
}

function refineManifestV3(manifest: ManifestV3Shape, ctx: z.RefinementCtx<ManifestV3Shape>): void {
  const issue = (path: PropertyKey[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const byId = new Map<string, HubEntryV3>();
  manifest.entries.forEach((entry, i) => {
    if (byId.has(entry.id)) issue(['entries', i, 'id'], `duplicate entry id ${entry.id}`);
    byId.set(entry.id, entry);
    if (!Object.hasOwn(manifest.families, entry.family)) issue(['entries', i, 'family'], `unknown family`);
  });
  manifest.tiers.forEach((tier, t) => {
    if (manifest.tiers.slice(0, t).some(o => o.memoryKind === tier.memoryKind && o.minGiB === tier.minGiB))
      issue(['tiers', t], 'duplicate tier');
    tier.picks.forEach((pick, p) => {
      const reason = pickV3Issue(pick, tier, byId);
      if (reason) issue(['tiers', t, 'picks', p], reason);
      if (tier.picks.slice(0, p).some(o => o.modality === pick.modality && o.slot === pick.slot))
        issue(['tiers', t, 'picks', p, 'slot'], 'slot taken');
    });
  });
  for (const modality of HUB_MODALITIES) {
    const ids = manifest.rankings[modality] ?? [];
    if (new Set(ids).size !== ids.length) issue(['rankings', modality], 'ranking lists an id twice');
    ids.forEach((id, i) => {
      if (byId.get(id)?.modality !== modality) issue(['rankings', modality, i], `no ${modality} entry ${id}`);
    });
  }
  const channel = manifest.v2Channel;
  if (channel) {
    for (const key of Object.keys(channel.contentSha256))
      if (Number(key) > channel.sequence) issue(['v2Channel', 'contentSha256', key], 'a later sequence');
  }
  manifest.v2Channel?.entries.forEach(({ entry: id, builds }, i) => {
    const path = ['v2Channel', 'entries', i];
    const entry = byId.get(id);
    if (entry?.modality !== 'text') return issue(path, `no text entry ${id}`);
    if (manifest.v2Channel?.entries.slice(0, i).some(other => other.entry === id))
      issue(path, `entry ${id} listed twice`);
    if (new Set(builds).size !== builds.length) issue([...path, 'builds'], 'a build is listed twice');
    builds.forEach((buildId, b) => {
      if (!entry.builds.some(build => build.id === buildId)) issue([...path, 'builds', b], `no build ${buildId}`);
    });
  });
}

/** Curated model manifest v3: entries carry a modality, builds a license label and measured runtime profiles. */
export const HubManifestV3Schema = ManifestV3ObjectSchema.superRefine(refineManifestV3);
export type HubManifestV3 = z.infer<typeof HubManifestV3Schema>;
export type HubManifestV3Input = z.input<typeof HubManifestV3Schema>;

/** The published v3 list: the same sequence and changelog rules as v2. */
export const CuratedCatalogV3Schema = HubManifestV3Schema.superRefine(refinePublishedCatalog);

/** The label a client shows for a license: the manifest's own, else a known label for its id, else the id. */
export function hubLicenseLabel(license: { id: string; label?: string }): string {
  return license.label ?? LICENSE_LABELS.get(license.id.toLowerCase()) ?? license.id;
}
