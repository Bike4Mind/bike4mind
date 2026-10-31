/**
 * External models command (b4m models ls|search|show|curated|servers|pull|rm|use).
 * Finds, downloads and selects local models on the configured Ollama runtime or a server saved in Desktop, with Hugging Face GGUF
 * repos resolved through @bike4mind/local-models. Runs outside the interactive CLI session.
 */

import { createInterface } from 'readline';
import { lookup } from 'dns/promises';
import { Writable } from 'stream';
import type { CuratedSlot, HubBuild, HubEntry, HubManifest, HubTier } from '@bike4mind/common';
import {
  HUGGING_FACE_SSH_KEYS_URL,
  HuggingFaceHub,
  curatedListing,
  curatedParamsLabel,
  curatedPicks,
  curatedRunner,
  curatedSource,
  isAbliteratedModel,
  isHubRepoId,
  isPermissiveEntry,
  loadCuratedManifest,
  ollamaLibraryLayers,
  probeHardware,
  RuntimeHttpError,
  type HardwareProfile,
  type HubGated,
  type HubGgufBuild,
} from '@bike4mind/local-models';
import {
  answersWithoutCredentials,
  parseServerAddress,
  leastTrusted,
  localModelId,
  probeServer,
  probeToolSupport,
  scopeOfIp,
  serverRuntimeId,
  toolsOffHint,
  transportVerdict,
  type AddressScope,
} from '@bike4mind/local-models/servers';
import { ConfigStore } from '../storage/ConfigStore.js';
import {
  defaultOn,
  findModelServer,
  loadModelServers,
  loginHint,
  needsCredential,
  noSuchServer,
  productLabel,
  requireManageable,
  resolveServerTarget,
  serverFetch,
  serverRedactor,
  validateSecret,
  type CliModelServer,
  type LoadedModelServers,
  type SecretFor,
} from '../models/modelServers.js';
import {
  CancelledError,
  NOT_RECOMMENDED_LABEL,
  NO_LICENSE,
  REF_ISSUES,
  UNPULLABLE,
  abortable,
  buildTag,
  clean,
  formatBytes,
  gatedMessage,
  hadTagBefore,
  installedUncheckedMessage,
  hiddenAbliteratedMessage,
  hubAccessMessage,
  licenseFor,
  licenseName,
  listInstalled,
  findInstalledModel,
  pickBuild,
  planPull,
  rankSearchHits,
  removeInstalled,
  requireInstalledReviewed,
  requireRemovable,
  requireReviewedLayers,
  requireUnchangedLicenses,
  requireUnchangedManifest,
  resolveRuntimeTarget,
  runtimeLabel,
  sameModelName,
  shortDigest,
  type HubClient,
  type LicenseInfo,
  type ModelSourceDeps,
  type PullPlan,
  type RuntimeTarget,
} from '../models/localModels.js';
import {
  FIT_LABELS,
  fitForHubBuild,
  fitForPlan,
  machineLabel,
  machineReader,
  type MachineReader,
  type ModelFit,
} from '../models/fit.js';
import { withDefaultOllamaPort } from '../utils/ollamaHost.js';
import { readOllamaManifest } from './ollamaRegistry.js';

interface ModelsCommandArgs {
  _: (string | number)[];
  name?: string;
  ref?: string;
  repo?: string;
  query?: string | string[];
  'include-abliterated'?: boolean;
  yes?: boolean;
  force?: boolean;
  'accept-license'?: boolean;
  'ollama-host'?: string;
  'output-format'?: string;
  server?: string;
  action?: string;
  'token-stdin'?: boolean;
  [key: string]: unknown;
}

/** Desktop's saved servers and the CLI's copy of their credentials. */
export interface ModelServersDeps {
  load: () => Promise<LoadedModelServers>;
  secret: SecretFor;
  saveSecret: (serverId: string, secret: string) => Promise<void>;
  clearSecret: (serverId: string) => Promise<void>;
  /** Reads one line with the terminal not echoing it. */
  readSecret: (prompt: string) => Promise<string>;
  readStdin: () => Promise<string>;
  /** Whether stdin is a terminal; only the hidden prompt needs one. Defaults to `isTTY`. */
  stdinIsTTY?: boolean;
  /** Addresses a host resolves to; defaults to the system resolver. */
  resolveHost?: (host: string) => Promise<string[]>;
}

export interface ModelsConfig {
  defaultModel: string | undefined;
  ollamaHost: string | undefined;
  save(patch: { defaultModel?: string; ollamaHost?: string; localDefaultModel?: string }): Promise<void>;
}

export interface ModelsDeps extends ModelSourceDeps {
  config: ModelsConfig;
  confirm: (question: string) => Promise<boolean>;
  isTTY: boolean;
  log: (line: string) => void;
  /** Rewrites one terminal line; only used when `isTTY`. */
  progress: { update: (line: string) => void; end: () => void };
  machine: MachineReader;
  /** The Ollama host a command would use before it is resolved; null when it would detect one on this machine. */
  runtimeHost: () => string | null;
  /** The curated list Desktop uses, bundled with the CLI. */
  curated: () => HubManifest;
  /** This computer's memory, which picks its tier of the Curated list. */
  hardware: () => Promise<HardwareProfile>;
  servers?: ModelServersDeps;
}

export interface ModelsOptions {
  json: boolean;
  yes: boolean;
  /** Pull a build the fit check rates too large. */
  force: boolean;
  acceptLicense: boolean;
  includeAbliterated: boolean;
  /** `servers`: also ask each OpenAI-compatible server whether it accepts tool calls. */
  checkTools?: boolean;
}

export type PullResult = 'pulled' | 'declined' | 'cancelled';

/** Exit code for a run stopped by Ctrl-C (128 + SIGINT). */
export const EXIT_CANCELLED = 130;

const SEARCH_LIMIT = 20;
const PROGRESS_INTERVAL_MS = 100;

function formatCount(count: number | null): string {
  if (count === null) return '-';
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`;
  return String(count);
}

function formatGated(gated: HubGated): string {
  return gated === false ? 'no' : `yes (${gated === 'manual' ? 'manual approval' : 'automatic approval'})`;
}

/** Left-aligned columns; the last column is not padded. */
function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map(row => row[col]?.length ?? 0)));
  return rows.map(row =>
    row
      .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col])))
      .join('  ')
      .trimEnd()
  );
}

export async function listModels(deps: ModelsDeps, opts: ModelsOptions): Promise<number> {
  const target = await abortable(deps.resolveRuntime(), deps.signal);
  const { runtime } = target;
  const rows = await listInstalled(runtime, defaultOn(target, deps.config.defaultModel), deps.signal);

  if (opts.json) {
    deps.log(
      JSON.stringify(
        {
          runtime: {
            kind: runtime.kind,
            baseUrl: runtime.baseUrl,
            source: target.source,
            ...(target.server && { server: target.server.name }),
          },
          models: rows,
        },
        null,
        2
      )
    );
    return 0;
  }
  deps.log(runtimeLabel(target));
  if (rows.length === 0) {
    deps.log(
      target.server
        ? `No models are served by ${clean(target.server.name)}.`
        : 'No models installed. Find one with: b4m models search <query>'
    );
    return 0;
  }
  if (target.server && runtime.kind === 'openai-compatible') {
    const lines = table([
      ['NAME', 'CONTEXT', 'NOTE'],
      ...rows.map(model => [
        clean(model.name),
        model.contextLength ? String(model.contextLength) : '-',
        [
          model.baseModel && `LoRA on ${clean(model.baseModel)}`,
          model.aliases && model.aliases.length > 0 && `also: ${model.aliases.map(clean).join(', ')}`,
          model.default && 'default',
        ]
          .filter(Boolean)
          .join('; '),
      ]),
    ]);
    for (const line of lines) deps.log(line);
    return 0;
  }
  const lines = table([
    ['NAME', 'SIZE', 'QUANT', 'CAPABILITIES', ''],
    ...rows.map(model => [
      clean(model.name),
      formatBytes(model.sizeBytes),
      clean(model.quantization) || '-',
      Object.entries(model.capabilities)
        .filter(([, has]) => has)
        .map(([name]) => name)
        .join(', ') || '-',
      [model.loaded && 'loaded', model.default && 'default'].filter(Boolean).join(', '),
    ]),
  ]);
  for (const line of lines) deps.log(line);
  return 0;
}

export async function searchModels(query: string, deps: ModelsDeps, opts: ModelsOptions): Promise<number> {
  const page = await deps.hub().search({ query, limit: SEARCH_LIMIT, signal: deps.signal });
  const { hits, hidden } = rankSearchHits(page.models, opts.includeAbliterated);
  if (opts.json) {
    deps.log(
      JSON.stringify(
        { ...page, models: hits, ...(hidden > 0 && { hidden: hiddenAbliteratedMessage(hidden) }) },
        null,
        2
      )
    );
    return 0;
  }
  if (hits.length === 0) {
    deps.log(`No GGUF models on Hugging Face match "${clean(query)}".`);
  } else {
    const labelled = hits.some(model => model.notRecommended);
    const lines = table([
      ['REPO', 'DOWNLOADS', 'LIKES', 'LICENSE', 'GATED', ...(labelled ? ['NOTE'] : [])],
      ...hits.map(model => [
        clean(model.id),
        formatCount(model.downloads),
        formatCount(model.likes),
        model.licenses.map(clean).join(', ') || '-',
        formatGated(model.gated),
        ...(labelled ? [model.notRecommended ? `not recommended: ${NOT_RECOMMENDED_LABEL}` : ''] : []),
      ]),
    ]);
    for (const line of lines) deps.log(line);
  }
  if (hidden > 0) {
    deps.log('');
    deps.log(`${hiddenAbliteratedMessage(hidden)} Show them with --include-abliterated.`);
  }
  if (hits.length === 0) return 0;
  deps.log('');
  deps.log('Builds and sizes: b4m models show <repo>');
  return 0;
}

export async function showModel(repo: string, deps: ModelsDeps, opts: ModelsOptions): Promise<number> {
  if (!isHubRepoId(repo)) throw new Error(`Not a Hugging Face repo: ${repo} (expected owner/name)`);
  const hub = deps.hub();
  const detail = await hub.getModel(repo, { signal: deps.signal });
  const reading = await abortable(deps.machine(deps.runtimeHost()), deps.signal);
  const fitOf = (build: HubGgufBuild): ModelFit => fitForHubBuild(build, detail, reading);
  if (opts.json) {
    const rated = { ...detail, builds: detail.builds.map(build => ({ ...build, fit: fitOf(build) })) };
    deps.log(
      JSON.stringify(isAbliteratedModel(detail) ? { ...rated, notRecommended: NOT_RECOMMENDED_LABEL } : rated, null, 2)
    );
    return 0;
  }
  const license = licenseFor(detail, hub.endpoint);
  const id = clean(detail.id);
  deps.log(id);
  deps.log(`  License:   ${license.label}${license.restricted ? ` (${license.link})` : ''}`);
  deps.log(
    `  Gated:     ${formatGated(detail.gated)}${detail.gated && detail.canDownload === true ? ', access granted' : ''}`
  );
  deps.log(`  Revision:  ${clean(detail.revision)}`);
  if (detail.baseModels.length > 0) deps.log(`  Based on:  ${detail.baseModels.map(clean).join(', ')}`);
  if (isAbliteratedModel(detail)) deps.log(`  Caution:   not recommended: ${NOT_RECOMMENDED_LABEL}`);
  if (detail.gguf) {
    const facts = [
      detail.gguf.architecture && clean(detail.gguf.architecture),
      detail.gguf.parameterCount !== null && `${formatCount(detail.gguf.parameterCount)} params`,
      detail.gguf.contextLength !== null && `${detail.gguf.contextLength} context`,
    ].filter(Boolean);
    if (facts.length > 0) deps.log(`  Model:     ${facts.join(', ')}`);
  }
  if (detail.gated && detail.canDownload !== true) {
    deps.log('');
    deps.log(gatedMessage(id, hub.endpoint));
  }

  deps.log('');
  if (detail.builds.length === 0) {
    deps.log('No GGUF builds in this repo.');
    return 0;
  }
  deps.log('Builds (smallest first):');
  const lines = table([
    ['BUILD', 'SIZE', 'FIT', 'OLLAMA REF'],
    ...detail.builds.map(build => [
      clean(build.label),
      formatBytes(build.sizeBytes),
      FIT_LABELS[fitOf(build).verdict],
      build.ollamaRef ? clean(build.ollamaRef) : `none: ${REF_ISSUES[build.ollamaRefIssue ?? 'unsupported-name']}`,
    ]),
  ]);
  for (const line of lines) deps.log(`  ${line}`);
  deps.log(
    'unknown' in reading
      ? `  Fit is unknown. ${reading.unknown}.`
      : `  Fit is a rough estimate from each file's size for this machine (${machineLabel(reading)}); pull explains it.`
  );
  if (detail.projectors.length > 0) {
    deps.log('');
    deps.log("Vision projectors (Ollama's Hugging Face registry adds one to each pull):");
    for (const projector of detail.projectors) {
      deps.log(`  ${clean(projector.path)}  ${clean(projector.quant) || '-'}  ${formatBytes(projector.sizeBytes)}`);
    }
  }
  const pullable = detail.builds.filter(build => !build.ollamaRefIssue || !UNPULLABLE.has(build.ollamaRefIssue));
  const suggested = pickBuild(pullable, null) ?? pullable.find(build => build.ollamaRef);
  if (suggested?.quant) {
    deps.log('');
    deps.log(`Pull one with: b4m models pull ${id}:${clean(buildTag(suggested))}`);
  }
  return 0;
}

const SLOT_LABELS: Record<CuratedSlot, string> = {
  best: 'Best',
  fast: 'Fast',
  'long-context': 'Long context',
  light: 'Light',
};
const TOOL_RATINGS = { weak: 'weak', ok: 'good', strong: 'strong' } as const;

const formatGiB = (bytes: number) => {
  const gib = bytes / 1024 ** 3;
  return `${gib >= 100 ? Math.round(gib) : Number(gib.toFixed(1))} GiB`;
};

function machineText(hw: HardwareProfile): string {
  const memory = formatGiB(hw.totalMemoryBytes);
  if (hw.memoryKind === 'unified') return `This computer has ${memory} of memory, shared with its GPU.`;
  if (hw.memoryKind === 'discrete' && hw.gpuMemoryBytes)
    return `This computer has ${memory} of RAM and ${formatGiB(hw.gpuMemoryBytes)} of GPU memory${
      hw.gpuName ? ` (${clean(hw.gpuName)})` : ''
    }.`;
  return `This computer has ${memory} of RAM and no GPU memory was detected, so its picks assume the CPU.`;
}

function tierText(tier: HubTier): string {
  if (tier.memoryKind === 'cpu') return 'CPU only';
  return `${tier.minGiB} GiB+ ${tier.memoryKind === 'discrete' ? 'GPU memory' : 'unified memory'}`;
}

function curatedTags(entry: HubEntry, build: HubBuild): string {
  const { rating } = entry.toolUse;
  const tools = !entry.capabilities.tools
    ? 'no tools'
    : rating === 'unrated'
      ? 'tools'
      : `tools: ${TOOL_RATINGS[rating]}`;
  const minimum = build.runtimeMin?.ollama;
  return [
    entry.capabilities.vision && 'vision',
    entry.capabilities.thinking && 'thinking',
    entry.roles.includes('code') && 'code',
    tools,
    minimum && `needs Ollama >= ${clean(minimum)}`,
  ]
    .filter((tag): tag is string => Boolean(tag))
    .join(', ');
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);

function isLoopbackHost(host: string): boolean {
  try {
    const { hostname } = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
    return LOOPBACK_HOSTS.has(hostname.toLowerCase()) || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

function curatedBuildJson(build: HubBuild) {
  const { ollamaRef, sizeBytes } = curatedSource(build);
  return {
    id: build.id,
    quant: build.quant.label,
    ref: ollamaRef,
    sizeBytes,
    ollamaMin: build.runtimeMin?.ollama ?? null,
  };
}

function curatedEntryJson(entry: HubEntry) {
  return {
    id: entry.id,
    name: entry.name,
    params: curatedParamsLabel(entry),
    why: entry.why,
    license: {
      id: entry.license.id,
      kind: isPermissiveEntry(entry) ? 'permissive' : 'restricted',
      url: entry.license.source,
      base: { id: entry.license.base.id, permissive: entry.license.base.class === 'permissive' },
    },
    vision: entry.capabilities.vision,
    thinking: entry.capabilities.thinking,
    code: entry.roles.includes('code'),
    tools: entry.capabilities.tools,
    toolUse: { rating: entry.toolUse.rating, note: entry.toolUse.note ?? null },
  };
}

function licenseCell(entry: HubEntry): string {
  const id = clean(entry.license.id);
  if (isPermissiveEntry(entry)) return id;
  const { base } = entry.license;
  return `restricted: ${id}${base.class === 'permissive' ? '' : ` (base: ${clean(base.id)})`}`;
}

const sizeOfBuild = (build: HubBuild) => curatedSource(build).sizeBytes;

/** Lists the Curated models without contacting any runtime; downloading one is always a separate `pull`. */
export async function listCurated(deps: ModelsDeps, opts: ModelsOptions): Promise<number> {
  const manifest = deps.curated();
  const hardware = await abortable(deps.hardware(), deps.signal);
  const listing = curatedListing(manifest).map(({ entry, builds }) => ({
    entry,
    builds: [...builds].sort((a, b) => sizeOfBuild(a) - sizeOfBuild(b)),
  }));
  const { tier, picks } = curatedPicks(manifest, hardware);

  if (opts.json) {
    deps.log(
      JSON.stringify(
        {
          updatedAt: manifest.updatedAt,
          machine: {
            memoryKind: hardware.memoryKind,
            totalMemoryBytes: hardware.totalMemoryBytes,
            gpuMemoryBytes: hardware.gpuMemoryBytes,
            gpuName: hardware.gpuName,
          },
          tier: tier && { memoryKind: tier.memoryKind, minGiB: tier.minGiB },
          picks: picks.map(({ pick, entry, build }) => ({
            slot: pick.slot,
            entryId: entry.id,
            name: entry.name,
            build: curatedBuildJson(build),
          })),
          entries: listing.map(({ entry, builds }) => ({
            ...curatedEntryJson(entry),
            builds: builds.map(curatedBuildJson),
          })),
        },
        null,
        2
      )
    );
    return 0;
  }

  deps.log(`Curated list from ${clean(manifest.updatedAt.slice(0, 10))}. ${machineText(hardware)}`);
  if (listing.length === 0) {
    deps.log('The Curated list has no models. Search Hugging Face with: b4m models search <query>');
    return 0;
  }
  const refOf = (build: HubBuild) => clean(curatedSource(build).ollamaRef);
  const sizeOf = (build: HubBuild) => formatBytes(sizeOfBuild(build));
  const host = deps.config.ollamaHost;
  if (host && !isLoopbackHost(host))
    deps.log(`The picks are for this computer, not the Ollama host at ${clean(host)}.`);

  deps.log('');
  if (!tier || picks.length === 0) {
    deps.log("For this computer: the list has no picks for this computer's memory yet.");
  } else {
    deps.log(`For this computer (${tierText(tier)}):`);
    const lines = table([
      ['SLOT', 'MODEL', 'REF', 'SIZE', 'LICENSE', 'TAGS'],
      ...picks.map(({ pick, entry, build }) => [
        SLOT_LABELS[pick.slot],
        clean(entry.name),
        refOf(build),
        sizeOf(build),
        licenseCell(entry),
        curatedTags(entry, build),
      ]),
    ]);
    for (const line of lines) deps.log(`  ${line}`);
  }

  deps.log('');
  deps.log('All curated models, smallest first:');
  const lines = table([
    ['MODEL', 'PARAMS', 'REF', 'SIZE', 'LICENSE', 'TAGS'],
    ...listing.flatMap(({ entry, builds }) =>
      builds.map(build => [
        clean(entry.name),
        clean(curatedParamsLabel(entry)),
        refOf(build),
        sizeOf(build),
        licenseCell(entry),
        curatedTags(entry, build),
      ])
    ),
  ]);
  for (const line of lines) deps.log(`  ${line}`);

  if (listing.some(({ entry }) => !isPermissiveEntry(entry))) {
    deps.log('');
    deps.log('A restricted license is not a permissive open-source license; pull asks you to accept it first.');
  }
  deps.log('');
  deps.log(`Pull one with: b4m models pull ${refOf(picks[0]?.build ?? listing[0].builds[0])}`);
  return 0;
}

/** Asks unless `--yes`; without a terminal to ask on, a missing `--yes` is an error. */
async function confirmDownload(question: string, deps: ModelsDeps, opts: ModelsOptions): Promise<boolean> {
  if (opts.yes) return true;
  if (!deps.isTTY) throw new Error('Re-run with --yes to download without a prompt.');
  return deps.confirm(question);
}

/** `runner` and `verify` come from a curated build: the runner Ollama must use, and the post-install check. */
async function pullWithProgress(
  target: RuntimeTarget,
  ref: string,
  deps: ModelsDeps,
  { runner, verify }: { runner?: string; verify?: () => Promise<void> } = {}
): Promise<PullResult> {
  let lastStatus = '';
  let lastDraw = 0;
  let sawBytes = false;
  try {
    await target.runtime.pull(ref, {
      runner,
      signal: deps.signal,
      onProgress: ({ status, completedBytes, totalBytes }) => {
        // A cached layer can precede the first partial one; wait until there is work left.
        if (!sawBytes && totalBytes && completedBytes < totalBytes) {
          sawBytes = true;
          if (completedBytes > 0) {
            if (deps.isTTY) deps.progress.end();
            deps.log(`Already downloaded: ${formatBytes(completedBytes)}; pulling the rest.`);
          }
        }
        const text = clean(target.redact ? target.redact(status) : status);
        if (!deps.isTTY) {
          if (text !== lastStatus) deps.log(text);
          lastStatus = text;
          return;
        }
        const now = Date.now();
        if (text === lastStatus && now - lastDraw < PROGRESS_INTERVAL_MS) return;
        lastStatus = text;
        lastDraw = now;
        // Ollama does not always send a layer's final byte count, so the sum is only shown while bytes flow.
        const amount =
          text.startsWith('pulling ') && totalBytes && totalBytes > 0
            ? `  ${Math.floor((completedBytes / totalBytes) * 100)}%  ${formatBytes(completedBytes)} / ${formatBytes(totalBytes)}`
            : '';
        deps.progress.update(`${text}${amount}`);
      },
    });
  } catch (error) {
    if (deps.isTTY) deps.progress.end();
    if (deps.signal.aborted) {
      deps.log(
        'Pull cancelled. Nothing was installed; Ollama keeps the partial download, so pulling again resumes it.'
      );
      return 'cancelled';
    }
    throw error;
  }
  if (deps.isTTY) deps.progress.end();
  if (verify) {
    deps.log('Checking the installed model against the reviewed build.');
    try {
      await verify();
    } catch (error) {
      if (!deps.signal.aborted) throw error;
      deps.log(installedUncheckedMessage(ref));
      return 'cancelled';
    }
  }
  deps.log(`Pulled ${clean(ref)}. Chat with it by default: b4m models use ${clean(ref)}`);
  return 'pulled';
}

/** Restricted or undeclared licenses need a yes at the prompt or `--accept-license`. */
async function acceptLicense(license: LicenseInfo, deps: ModelsDeps, opts: ModelsOptions): Promise<boolean> {
  if (!license.restricted) return true;
  const declared = license.label !== NO_LICENSE || license.base !== undefined;
  const noun = license.plural ? 'licenses' : 'license';
  const named = licenseName(license);
  deps.log('');
  deps.log(
    declared
      ? `This model is under the ${named} ${noun}, ${license.plural ? 'which are not all permissive open-source licenses' : 'which is not a permissive open-source license'}.`
      : 'This model does not declare a license.'
  );
  deps.log(`Read ${declared ? (license.plural ? 'them' : 'it') : 'its page'} before downloading: ${license.link}`);
  if (opts.acceptLicense) return true;
  if (!deps.isTTY) throw new Error('Re-run with --accept-license once you have read and accepted the license.');
  return deps.confirm(declared ? `Do you accept the ${named} ${noun}? [y/N] ` : 'Download it anyway? [y/N] ');
}

/** Prints the fit verdict; a too-large one stops the pull unless `--force`. Unknown never does. */
async function requireFit(plan: PullPlan, deps: ModelsDeps, opts: ModelsOptions): Promise<void> {
  const fit = await abortable(fitForPlan(plan, deps.machine), deps.signal);
  deps.log(`Fit:      ${FIT_LABELS[fit.verdict]}. ${fit.detail}`);
  if (fit.verdict !== 'too-large' || opts.force) return;
  if (fit.gpuUnread) {
    throw new Error(
      'Nothing was downloaded: this build is rated too large from system RAM alone, since the GPU could not be read. If this machine has a GPU that can hold it, re-run with --force to download it anyway.'
    );
  }
  const smaller =
    plan.kind === 'ollama' ? 'Pick a smaller tag' : `Pick a smaller quant from: b4m models show ${plan.id}`;
  throw new Error(
    `Nothing was downloaded: this build is rated too large for this machine. ${smaller}, or re-run with --force to download it anyway.`
  );
}

export async function pullModel(input: string, deps: ModelsDeps, opts: ModelsOptions): Promise<PullResult> {
  const plan = await planPull(input, deps);
  if (plan.kind === 'ollama') {
    const { name, manifest, license, target } = plan;
    deps.log(`Model:    ${clean(name)} (Ollama registry)`);
    deps.log(`Digest:   ${shortDigest(manifest.digest)}`);
    deps.log(`Size:     ${formatBytes(manifest.sizeBytes)}`);
    deps.log(`License:  ${license.label}${license.base ? ` (base: ${license.base})` : ''}`);
    deps.log(`Runtime:  ${runtimeLabel(target)}`);
    await requireFit(plan, deps, opts);
    if (!(await acceptLicense(license, deps, opts))) return 'declined';
    if (!(await confirmDownload(`Download ${formatBytes(manifest.sizeBytes)}? [y/N] `, deps, opts))) return 'declined';
    await requireUnchangedManifest(name, manifest, deps);
    return pullReviewed(plan, name, deps);
  }

  const { hub, detail, build, id, target, license, projectorBytes: projector } = plan;
  deps.log(`Model:    ${id} (${clean(build.label)})`);
  deps.log(`File:     ${build.files.map(file => clean(file.path)).join(', ')}`);
  deps.log(
    `Size:     ${formatBytes(build.sizeBytes)}${projector > 0 ? ` plus a vision projector of up to ${formatBytes(projector)}` : ''}`
  );
  deps.log(`License:  ${license.label}${license.base ? ` (base: ${license.base})` : ''}`);
  deps.log(`Runtime:  ${runtimeLabel(target)}`);
  await requireFit(plan, deps, opts);
  if (detail.ollamaNeedsSshKey) {
    deps.log('');
    deps.log(
      `Ollama downloads ${detail.private ? 'private' : 'gated'} repos with its own key: add ~/.ollama/id_ed25519.pub ` +
        `of the Ollama host at ${HUGGING_FACE_SSH_KEYS_URL} if you have not.`
    );
  }

  if (!(await acceptLicense(license, deps, opts))) return 'declined';
  if (!(await confirmDownload(`Download ${formatBytes(build.sizeBytes)}? [y/N] `, deps, opts))) return 'declined';

  let ref: string | null;
  try {
    await requireUnchangedLicenses(hub, detail, license, deps.signal);
    ref = await hub.verifyOllamaRef(detail, build, { signal: deps.signal });
  } catch (error) {
    if (deps.signal.aborted) {
      deps.log('Pull cancelled before the download started.');
      return 'cancelled';
    }
    throw error;
  }
  if (!ref) {
    throw new Error(
      `Hugging Face's registry does not serve this exact ${clean(build.label)} file to Ollama, so nothing was downloaded. ` +
        `Pick another build from: b4m models show ${id}`
    );
  }
  return pullReviewed(plan, ref, deps);
}

/** Pulls `ref`; a curated build is checked against its reviewed pins first and once Ollama has installed it. */
async function pullReviewed(plan: PullPlan, ref: string, deps: ModelsDeps): Promise<PullResult> {
  const { curated, target } = plan;
  if (!curated) return pullWithProgress(target, ref, deps);
  let hadTag: boolean | null;
  try {
    await requireReviewedLayers(curated, ref, deps);
    hadTag = await hadTagBefore(target, ref, deps.signal);
  } catch (error) {
    if (deps.signal.aborted) {
      deps.log('Pull cancelled before the download started.');
      return 'cancelled';
    }
    throw error;
  }
  return pullWithProgress(target, ref, deps, {
    runner: curatedRunner(curated.build),
    verify: () => requireInstalledReviewed(target, curated, ref, hadTag, deps.signal),
  });
}

export async function removeModel(name: string, deps: ModelsDeps, opts: ModelsOptions): Promise<number> {
  const target = await abortable(deps.resolveRuntime(), deps.signal);
  requireRemovable(target);
  if (!opts.yes) {
    if (!deps.isTTY) throw new Error('Re-run with --yes to remove without a prompt.');
    if (!(await deps.confirm(`Remove ${clean(name)} from ${runtimeLabel(target)}? [y/N] `))) {
      deps.log('Aborted');
      return 0;
    }
  }
  const installed = findInstalledModel(await abortable(target.runtime.list(), deps.signal), name);
  await removeInstalled(target, installed?.name ?? name, deps.signal);
  deps.log(`Removed ${clean(name)}.`);
  const currentDefault = defaultOn(target, deps.config.defaultModel);
  if (currentDefault && sameModelName(currentDefault, name)) {
    deps.log('It was your default model; pick another with: b4m models use <name>');
  }
  return 0;
}

export async function useModel(name: string, deps: ModelsDeps): Promise<number> {
  const target = await abortable(deps.resolveRuntime(), deps.signal);
  if (target.server) return useServerModel(name, { ...target, server: target.server }, deps);
  const { runtime } = target;
  // The chat backend (OllamaBackend in @bike4mind/llm-adapters) only talks to Ollama.
  if (runtime.kind !== 'ollama')
    throw new Error(`The CLI chats with local models through Ollama; ${runtimeLabel(target)} is not Ollama.`);
  const models = await abortable(runtime.list(), deps.signal);
  const model = findInstalledModel(models, name);
  if (!model) throw new Error(`No model named ${clean(name)} on ${runtimeLabel(target)}. See: b4m models ls`);
  await deps.config.save({
    defaultModel: model.name,
    localDefaultModel: model.name,
    ...(deps.config.ollamaHost !== runtime.baseUrl && { ollamaHost: runtime.baseUrl }),
  });
  deps.log(`Default model: ${clean(model.name)} on Ollama at ${runtime.baseUrl}`);
  deps.log('Start chatting with: b4m');
  return 0;
}

/** Saves the server's id with the model, so chat goes to that server and never to a same-named model elsewhere. */
async function useServerModel(
  name: string,
  target: RuntimeTarget & { server: NonNullable<RuntimeTarget['server']> },
  deps: ModelsDeps
): Promise<number> {
  const server = clean(target.server.name);
  const models = await abortable(target.runtime.list(), deps.signal);
  const model = findInstalledModel(models, name) ?? models.find(listed => listed.aliases?.includes(name));
  if (!model) {
    throw new Error(`No model named ${clean(name)} on ${server}. See: b4m models ls --server ${server}`);
  }
  if (model.name !== name && model.aliases?.includes(name)) {
    deps.log(`${clean(name)} is another name for ${clean(model.name)} on ${server}; saving ${clean(model.name)}.`);
  }
  const id = localModelId(serverRuntimeId(target.server.id), model.name);
  await deps.config.save({ defaultModel: id, localDefaultModel: id });
  deps.log(`Default model: ${clean(model.name)} on ${server}`);
  deps.log('Start chatting with: b4m');
  return 0;
}

function requireServers(deps: ModelsDeps): ModelServersDeps {
  if (!deps.servers) throw new Error('Model servers are not available here.');
  return deps.servers;
}

async function scopeOfHost(host: string, resolve?: ModelServersDeps['resolveHost']): Promise<AddressScope | null> {
  const literal = scopeOfIp(host);
  if (literal) return literal;
  try {
    const answer = await Promise.race([
      resolve ? resolve(host) : lookup(host, { all: true }).then(found => found.map(entry => entry.address)),
      new Promise<null>(done => setTimeout(() => done(null), 1_500).unref()),
    ]);
    const scopes = (answer ?? []).flatMap(address => scopeOfIp(address) ?? []);
    return scopes.length > 0 ? leastTrusted(scopes) : null;
  } catch {
    return null;
  }
}

const SERVER_APP = { name: 'the CLI', recheck: 'then check again with: b4m models servers --check-tools' } as const;

interface ServerRow {
  server: CliModelServer;
  product: string;
  credentials: 'none' | 'set' | 'needed';
  status: { state: 'online' | 'credentials' | 'refused' | 'offline'; latencyMs: number | null; text: string };
  notes: string[];
}

async function describeServer(server: CliModelServer, ctx: ModelServersDeps, checkTools: boolean): Promise<ServerRow> {
  const secret = ctx.secret(server.id);
  const credentials = server.auth.type === 'none' ? 'none' : needsCredential(server, secret) ? 'needed' : 'set';
  const base = { server, credentials } as const;
  const parsed = parseServerAddress(server.transport.baseUrl);
  if (!parsed) {
    return {
      ...base,
      product: productLabel(server.kind, null),
      status: { state: 'offline', latencyMs: null, text: 'unusable address' },
      notes: [],
    };
  }
  const redactor = serverRedactor(server, secret);
  const fetch = serverFetch(server, secret);
  const outcome = await probeServer(fetch, parsed.baseUrl, server.name, () => performance.now(), server.kind);
  const scope = await scopeOfHost(parsed.host, ctx.resolveHost);
  const notes: string[] = [];
  if (scope) {
    const verdict = transportVerdict(parsed.protocol, scope, credentials === 'set');
    if (!verdict.ok) notes.push(verdict.reason);
    else if (verdict.unencrypted) notes.push('Unencrypted');
  }
  if (outcome.kind && scope === 'public') {
    const open = await answersWithoutCredentials(serverFetch(server, undefined), parsed.baseUrl, outcome.kind);
    if (open) notes.push('Open to anyone');
  }
  const model = server.models[0];
  if (checkTools && outcome.kind === 'openai-compatible' && model) {
    if ((await probeToolSupport(fetch, parsed.baseUrl, model)) === 'refused') {
      notes.push(toolsOffHint(server.name, outcome.product, SERVER_APP));
    }
  }
  const text = (value: string) => clean(redactor ? redactor.redact(value) : value);
  let status: ServerRow['status'];
  if (outcome.kind) {
    status = { state: 'online', latencyMs: outcome.latencyMs, text: `online (${outcome.latencyMs ?? '?'} ms)` };
  } else if (outcome.auth) {
    status = {
      state: 'credentials',
      latencyMs: null,
      text: credentials === 'set' ? 'refused the saved credentials' : 'needs credentials',
    };
  } else {
    status = {
      state: outcome.refused || outcome.forbidden ? 'refused' : 'offline',
      latencyMs: null,
      text: text(outcome.error ?? 'offline'),
    };
  }
  return { ...base, product: productLabel(outcome.kind ?? server.kind, outcome.product), status, notes };
}

export async function listServers(deps: ModelsDeps, opts: ModelsOptions): Promise<number> {
  const ctx = requireServers(deps);
  const loaded = await abortable(ctx.load(), deps.signal);
  const rows = await abortable(
    Promise.all(loaded.servers.map(server => describeServer(server, ctx, Boolean(opts.checkTools)))),
    deps.signal
  );
  if (opts.json) {
    deps.log(
      JSON.stringify(
        {
          problem: loaded.problem,
          toolsChecked: Boolean(opts.checkTools),
          servers: rows.map(({ server, product, credentials, status, notes }) => ({
            id: server.id,
            name: server.name,
            kind: server.kind,
            product,
            address: server.transport.baseUrl,
            access: server.access,
            source: server.source,
            credentials,
            status,
            notes,
          })),
        },
        null,
        2
      )
    );
    return 0;
  }
  if (rows.length === 0) {
    deps.log(loaded.problem ?? 'No model servers are saved in Desktop. Add one in Desktop under Settings.');
    return 0;
  }
  if (loaded.problem) deps.log(loaded.problem);
  const lines = table([
    ['NAME', 'KIND', 'ADDRESS', 'ACCESS', 'CREDENTIALS', 'STATUS', 'NOTE'],
    ...rows.map(({ server, product, credentials, status, notes }) => [
      clean(server.name),
      product,
      clean(server.transport.baseUrl),
      server.access === 'manage' ? 'Manage' : 'Chat only',
      credentials === 'needed' ? `needed: ${loginHint(server)}` : credentials,
      status.text,
      notes.map(clean).join(' '),
    ]),
  ]);
  for (const line of lines) deps.log(line);
  if (!opts.checkTools && rows.some(row => row.server.kind === 'openai-compatible' && row.status.state === 'online')) {
    deps.log('');
    deps.log('Tool support: not checked. Add --check-tools to send each OpenAI-compatible server a one-token request.');
  }
  return 0;
}

async function chosenServer(name: string, ctx: ModelServersDeps, signal: AbortSignal) {
  const loaded = await abortable(ctx.load(), signal);
  const server = findModelServer(loaded.servers, name);
  if (!server) throw noSuchServer(loaded, name);
  return server;
}

export async function loginServer(name: string, deps: ModelsDeps, opts: { tokenStdin: boolean }): Promise<number> {
  const ctx = requireServers(deps);
  const server = await chosenServer(name, ctx, deps.signal);
  const label = clean(server.name);
  if (server.auth.type === 'none') throw new Error(`${label} does not use credentials.`);
  let entered: string;
  if (opts.tokenStdin) {
    entered = await abortable(ctx.readStdin(), deps.signal);
  } else if (ctx.stdinIsTTY ?? deps.isTTY) {
    const what = server.auth.type === 'bearer' ? 'Token' : `Value for the ${clean(server.auth.name)} header`;
    entered = await ctx.readSecret(`${what} for ${label}: `);
  } else {
    throw new Error('Re-run with --token-stdin to give the credential without a prompt.');
  }
  const secret = validateSecret(server, entered);
  const refused = () => new Error(`${label} refused these credentials. Nothing was saved.`);
  const target = await resolveServerTarget(server, secret).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/refused the saved credentials|needs credentials/.test(message)) throw refused();
    throw error;
  });
  // A server can leave its version endpoint open, so only an authenticated listing proves the credential.
  try {
    await abortable(target.runtime.list(), deps.signal);
  } catch (error) {
    if (error instanceof RuntimeHttpError && (error.status === 401 || error.status === 403)) throw refused();
    throw error;
  }
  await ctx.saveSecret(server.id, secret);
  deps.log(`Saved the credentials for ${label}; ${runtimeLabel(target)} answered.`);
  return 0;
}

export async function logoutServer(name: string, deps: ModelsDeps): Promise<number> {
  const ctx = requireServers(deps);
  const loaded = await abortable(ctx.load(), deps.signal);
  const known = findModelServer(loaded.servers, name);
  // A server removed in Desktop leaves its credential behind under the old id; that id removes it.
  const id = known?.id ?? (ctx.secret(name) !== undefined ? name : null);
  if (id === null) throw noSuchServer(loaded, name);
  const label = clean(known?.name ?? name);
  if (ctx.secret(id) === undefined) {
    deps.log(`The CLI has no saved credentials for ${label}.`);
    return 0;
  }
  await ctx.clearSecret(id);
  deps.log(`Removed the CLI's saved credentials for ${label}. Desktop's copy is untouched.`);
  return 0;
}

/** `--server`: the same command, run against one of Desktop's saved servers. */
async function onServer(name: string, subcommand: string, deps: ModelsDeps): Promise<ModelsDeps> {
  const ctx = requireServers(deps);
  const server = await chosenServer(name, ctx, deps.signal);
  if (subcommand === 'pull' || subcommand === 'rm' || subcommand === 'remove') requireManageable(server);
  return {
    ...deps,
    resolveRuntime: () => abortable(resolveServerTarget(server, ctx.secret(server.id)), deps.signal),
  };
}

function positional(value: string | string[] | undefined, usage: string): string {
  const text = (Array.isArray(value) ? value.join(' ') : (value ?? '')).trim();
  if (!text) throw new Error(`Usage: ${usage}`);
  return text;
}

export async function runModelsCommand(
  subcommand: string | undefined,
  argv: ModelsCommandArgs,
  deps: ModelsDeps
): Promise<number> {
  const opts: ModelsOptions = {
    json: argv['output-format'] === 'json',
    yes: Boolean(argv.yes),
    force: Boolean(argv.force),
    acceptLicense: Boolean(argv['accept-license']),
    includeAbliterated: Boolean(argv['include-abliterated']),
    checkTools: Boolean(argv['check-tools']),
  };
  try {
    if (argv.server !== undefined) {
      const serverName = String(argv.server).trim();
      if (!serverName) throw new Error('--server needs a server name (see: b4m models servers)');
      if (!['ls', 'list', 'use', 'pull', 'rm', 'remove'].includes(subcommand ?? '')) {
        throw new Error('--server works with ls, use, pull and rm.');
      }
      deps = await onServer(serverName, subcommand ?? '', deps);
    }
    switch (subcommand) {
      case 'servers': {
        const name = () => positional(argv.name, `b4m models servers ${argv.action} <name>`);
        if (argv.action === undefined) return await listServers(deps, opts);
        if (argv.action === 'login')
          return await loginServer(name(), deps, { tokenStdin: Boolean(argv['token-stdin']) });
        if (argv.action === 'logout') return await logoutServer(name(), deps);
        throw new Error(`Unknown servers action: ${clean(String(argv.action))}. Use login or logout.`);
      }
      case 'ls':
      case 'list':
        return await listModels(deps, opts);
      case 'search':
        return await searchModels(positional(argv.query, 'b4m models search <query>'), deps, opts);
      case 'show':
        return await showModel(positional(argv.repo, 'b4m models show <owner/repo>'), deps, opts);
      case 'curated':
        return await listCurated(deps, opts);
      case 'pull': {
        const result = await pullModel(positional(argv.ref, 'b4m models pull <ref | owner/repo[:quant]>'), deps, opts);
        if (result === 'declined') deps.log('Aborted');
        return result === 'cancelled' ? EXIT_CANCELLED : 0;
      }
      case 'rm':
      case 'remove':
        return await removeModel(positional(argv.name, 'b4m models rm <name>'), deps, opts);
      case 'use':
        return await useModel(positional(argv.name, 'b4m models use <name>'), deps);
      default:
        throw new Error(`Unknown models subcommand: ${subcommand ?? '(none)'}`);
    }
  } catch (error) {
    if (error instanceof CancelledError || deps.signal.aborted) {
      deps.log('Cancelled.');
      return EXIT_CANCELLED;
    }
    const refused = hubAccessMessage(error, () => deps.hub().endpoint);
    if (refused) throw new Error(refused);
    throw new Error(clean(error instanceof Error ? error.message : String(error)));
  }
}

/** Resolves the answer; rejects with `CancelledError` on Ctrl-C at the prompt or when `signal` aborts. */
export function confirmOnTerminal(
  question: string,
  signal: AbortSignal,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  }
): Promise<boolean> {
  if (signal.aborted) return Promise.reject(new CancelledError());
  const rl = createInterface({ input: streams.input, output: streams.output });
  return new Promise<boolean>((resolve, reject) => {
    const cancel = () => {
      streams.output.write('\n');
      rl.close();
      reject(new CancelledError());
    };
    const finish = (answer: string) => {
      signal.removeEventListener('abort', cancel);
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    };
    // readline holds the terminal in raw mode, so Ctrl-C at the prompt arrives here, not as a process SIGINT.
    rl.on('SIGINT', () => {
      signal.removeEventListener('abort', cancel);
      cancel();
    });
    signal.addEventListener('abort', cancel, { once: true });
    rl.question(question, finish);
  });
}

/** Reads one line without echoing it; the prompt goes to stderr so a piped stdout stays clean. */
export function readSecretOnTerminal(
  prompt: string,
  signal: AbortSignal,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stderr,
  }
): Promise<string> {
  if (signal.aborted) return Promise.reject(new CancelledError());
  let echo = true;
  const muted = new Writable({
    write(chunk, encoding, done) {
      if (echo) streams.output.write(chunk, encoding);
      done();
    },
  });
  const rl = createInterface({ input: streams.input, output: muted, terminal: true });
  return new Promise<string>((resolve, reject) => {
    const cancel = () => {
      streams.output.write('\n');
      rl.close();
      reject(new CancelledError());
    };
    rl.on('SIGINT', () => {
      signal.removeEventListener('abort', cancel);
      cancel();
    });
    signal.addEventListener('abort', cancel, { once: true });
    rl.question(prompt, answer => {
      signal.removeEventListener('abort', cancel);
      rl.close();
      streams.output.write('\n');
      resolve(answer);
    });
    echo = false;
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function handleModelsCommand(subcommand: string | undefined, argv: ModelsCommandArgs): Promise<number> {
  const configStore = new ConfigStore();
  const config = await configStore.load();
  let credentials = { ...config.modelServerCredentials };
  const models: ModelsConfig = {
    defaultModel: config.defaultModel,
    ollamaHost: config.ollamaHost,
    save: async patch => {
      await configStore.update(patch);
      Object.assign(models, patch);
    },
  };

  const flagHost = argv['ollama-host'];
  if (flagHost === '' && models.ollamaHost) {
    await models.save({ ollamaHost: undefined });
    console.error('Cleared the saved Ollama host.');
  }

  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(EXIT_CANCELLED);
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  let hub: HubClient | undefined;
  try {
    return await runModelsCommand(subcommand, argv, {
      hub: () => (hub ??= new HuggingFaceHub({ token: process.env.HF_TOKEN })),
      ollamaRegistry: (name, signal) => readOllamaManifest(name, signal),
      libraryLayers: (ref, signal) => ollamaLibraryLayers(ref, { signal }),
      resolveRuntime: async () => {
        const target = await resolveRuntimeTarget({
          flag: flagHost || undefined,
          env: process.env.B4M_OLLAMA_HOST,
          config: models.ollamaHost,
        });
        // Remembered only once it answered, so a typo never replaces a working saved host.
        if (target.source === 'flag' && target.runtime.baseUrl !== models.ollamaHost) {
          await models.save({ ollamaHost: target.runtime.baseUrl });
          console.error(`Saved Ollama host ${target.runtime.baseUrl}`);
        }
        return target;
      },
      config: models,
      confirm: question => confirmOnTerminal(question, controller.signal),
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      log: line => console.log(line),
      progress: {
        update: line => process.stdout.write(`\r\x1b[2K${line}`),
        end: () => process.stdout.write('\n'),
      },
      machine: machineReader(),
      runtimeHost: () => {
        const host = flagHost || process.env.B4M_OLLAMA_HOST || models.ollamaHost;
        return host ? withDefaultOllamaPort(host) : null;
      },
      curated: () => loadCuratedManifest(message => console.error(message)),
      hardware: () => probeHardware(),
      servers: {
        load: () => loadModelServers(),
        secret: id => credentials[id]?.secret,
        saveSecret: async (id, secret) => {
          await configStore.setModelServerCredential(id, secret);
          credentials = { ...credentials, [id]: { secret } };
        },
        clearSecret: async id => {
          await configStore.clearModelServerCredential(id);
          const { [id]: removed, ...rest } = credentials;
          void removed;
          credentials = rest;
        },
        readSecret: prompt => readSecretOnTerminal(prompt, controller.signal),
        readStdin: readAllStdin,
        stdinIsTTY: Boolean(process.stdin.isTTY),
      },
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onSigint);
  }
}
