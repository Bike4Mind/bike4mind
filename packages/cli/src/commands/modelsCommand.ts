/**
 * External models command (b4m models ls|search|show|curated|pull|rm|use).
 * Finds, downloads and selects local models on the configured Ollama runtime, with Hugging Face GGUF
 * repos resolved through @bike4mind/local-models. Runs outside the interactive CLI session.
 */

import { createInterface } from 'readline';
import type { CuratedSlot, HubBuild, HubEntry, HubManifest, HubTier } from '@bike4mind/common';
import {
  HUGGING_FACE_SSH_KEYS_URL,
  HuggingFaceHub,
  curatedListing,
  curatedParamsLabel,
  curatedPicks,
  curatedSource,
  isAbliteratedModel,
  isHubRepoId,
  isPermissiveEntry,
  loadCuratedManifest,
  probeHardware,
  type HardwareProfile,
  type HubGated,
} from '@bike4mind/local-models';
import { ConfigStore } from '../storage/ConfigStore.js';
import {
  CancelledError,
  NOT_RECOMMENDED_LABEL,
  NO_LICENSE,
  REF_ISSUES,
  UNPULLABLE,
  abortable,
  clean,
  formatBytes,
  gatedMessage,
  hiddenAbliteratedMessage,
  hubAccessMessage,
  licenseFor,
  listInstalled,
  normalizeModelName,
  pickBuild,
  planPull,
  rankSearchHits,
  removeInstalled,
  requireRemovable,
  requireUnchangedLicenses,
  requireUnchangedManifest,
  resolveRuntimeTarget,
  runtimeLabel,
  shortDigest,
  type HubClient,
  type LicenseInfo,
  type ModelSourceDeps,
  type RuntimeTarget,
} from '../models/localModels.js';
import { readOllamaManifest } from './ollamaRegistry.js';

interface ModelsCommandArgs {
  _: (string | number)[];
  name?: string;
  ref?: string;
  repo?: string;
  query?: string | string[];
  'include-abliterated'?: boolean;
  yes?: boolean;
  'accept-license'?: boolean;
  'ollama-host'?: string;
  'output-format'?: string;
  [key: string]: unknown;
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
  /** The Curated list bundled with the CLI, the same one Desktop's Curated tab shows. */
  curated: () => HubManifest;
  /** This computer's memory, which picks its tier of the Curated list. */
  hardware: () => Promise<HardwareProfile>;
}

export interface ModelsOptions {
  json: boolean;
  yes: boolean;
  acceptLicense: boolean;
  includeAbliterated: boolean;
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
  const rows = await listInstalled(runtime, deps.config.defaultModel, deps.signal);

  if (opts.json) {
    deps.log(
      JSON.stringify(
        { runtime: { kind: runtime.kind, baseUrl: runtime.baseUrl, source: target.source }, models: rows },
        null,
        2
      )
    );
    return 0;
  }
  deps.log(runtimeLabel(target));
  if (rows.length === 0) {
    deps.log('No models installed. Find one with: b4m models search <query>');
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
  if (opts.json) {
    deps.log(
      JSON.stringify(
        isAbliteratedModel(detail) ? { ...detail, notRecommended: NOT_RECOMMENDED_LABEL } : detail,
        null,
        2
      )
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
    ['QUANT', 'SIZE', 'OLLAMA REF'],
    ...detail.builds.map(build => [
      clean(build.quant) || clean(build.id),
      formatBytes(build.sizeBytes),
      build.ollamaRef ? clean(build.ollamaRef) : `none: ${REF_ISSUES[build.ollamaRefIssue ?? 'unsupported-name']}`,
    ]),
  ]);
  for (const line of lines) deps.log(`  ${line}`);
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
    deps.log(`Pull one with: b4m models pull ${id}:${clean(suggested.quant)}`);
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

function curatedTags(entry: HubEntry): string[] {
  const { rating } = entry.toolUse;
  const tools = !entry.capabilities.tools
    ? 'no tools'
    : rating === 'unrated'
      ? 'tools'
      : `tools: ${TOOL_RATINGS[rating]}`;
  return [
    entry.capabilities.vision && 'vision',
    entry.capabilities.thinking && 'thinking',
    entry.roles.includes('code') && 'code',
    tools,
  ].filter((tag): tag is string => Boolean(tag));
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
  return isPermissiveEntry(entry) ? id : `restricted: ${id}`;
}

/** Lists the Curated models without contacting any runtime; downloading one is always a separate `pull`. */
export async function listCurated(deps: ModelsDeps, opts: ModelsOptions): Promise<number> {
  const manifest = deps.curated();
  const hardware = await abortable(deps.hardware(), deps.signal);
  const listing = curatedListing(manifest);
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
  const sizeOf = (build: HubBuild) => formatBytes(curatedSource(build).sizeBytes);

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
        curatedTags(entry).join(', '),
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
        curatedTags(entry).join(', '),
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

async function pullWithProgress(target: RuntimeTarget, ref: string, deps: ModelsDeps): Promise<PullResult> {
  let lastStatus = '';
  let lastDraw = 0;
  try {
    await target.runtime.pull(ref, {
      signal: deps.signal,
      onProgress: ({ status, completedBytes, totalBytes }) => {
        const text = clean(status);
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
  deps.log(`Pulled ${clean(ref)}. Chat with it by default: b4m models use ${clean(ref)}`);
  return 'pulled';
}

/** Restricted or undeclared licenses need a yes at the prompt or `--accept-license`. */
async function acceptLicense(license: LicenseInfo, deps: ModelsDeps, opts: ModelsOptions): Promise<boolean> {
  if (!license.restricted) return true;
  const declared = license.label !== NO_LICENSE;
  const noun = license.plural ? 'licenses' : 'license';
  deps.log('');
  deps.log(
    declared
      ? `This model is under the ${license.label} ${noun}, ${license.plural ? 'which are not all permissive open-source licenses' : 'which is not a permissive open-source license'}.`
      : 'This model does not declare a license.'
  );
  deps.log(`Read ${declared ? (license.plural ? 'them' : 'it') : 'its page'} before downloading: ${license.link}`);
  if (opts.acceptLicense) return true;
  if (!deps.isTTY) throw new Error('Re-run with --accept-license once you have read and accepted the license.');
  return deps.confirm(declared ? `Do you accept the ${license.label} ${noun}? [y/N] ` : 'Download it anyway? [y/N] ');
}

export async function pullModel(input: string, deps: ModelsDeps, opts: ModelsOptions): Promise<PullResult> {
  const plan = await planPull(input, deps);
  if (plan.kind === 'ollama') {
    const { name, manifest, license, target } = plan;
    deps.log(`Model:    ${clean(name)} (Ollama registry)`);
    deps.log(`Digest:   ${shortDigest(manifest.digest)}`);
    deps.log(`Size:     ${formatBytes(manifest.sizeBytes)}`);
    deps.log(`License:  ${license.label}`);
    deps.log(`Runtime:  ${runtimeLabel(target)}`);
    if (!(await acceptLicense(license, deps, opts))) return 'declined';
    if (!(await confirmDownload(`Download ${formatBytes(manifest.sizeBytes)}? [y/N] `, deps, opts))) return 'declined';
    await requireUnchangedManifest(name, manifest, deps);
    return pullWithProgress(target, name, deps);
  }

  const { hub, detail, build, id, target, license, projectorBytes: projector } = plan;
  deps.log(`Model:    ${id} (${clean(build.quant)})`);
  deps.log(`File:     ${build.files.map(file => clean(file.path)).join(', ')}`);
  deps.log(
    `Size:     ${formatBytes(build.sizeBytes)}${projector > 0 ? ` plus a vision projector of up to ${formatBytes(projector)}` : ''}`
  );
  deps.log(`License:  ${license.label}`);
  deps.log(`Runtime:  ${runtimeLabel(target)}`);
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
      `Hugging Face's registry does not serve this exact ${clean(build.quant)} file to Ollama, so nothing was downloaded. ` +
        `Pick another build from: b4m models show ${id}`
    );
  }
  return pullWithProgress(target, ref, deps);
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
  await removeInstalled(target, name, deps.signal);
  deps.log(`Removed ${clean(name)}.`);
  if (deps.config.defaultModel && normalizeModelName(deps.config.defaultModel) === normalizeModelName(name)) {
    deps.log('It was your default model; pick another with: b4m models use <name>');
  }
  return 0;
}

export async function useModel(name: string, deps: ModelsDeps): Promise<number> {
  const target = await abortable(deps.resolveRuntime(), deps.signal);
  const { runtime } = target;
  // The chat backend (OllamaBackend in @bike4mind/llm-adapters) only talks to Ollama.
  if (runtime.kind !== 'ollama')
    throw new Error(`The CLI chats with local models through Ollama; ${runtimeLabel(target)} is not Ollama.`);
  const models = await abortable(runtime.list(), deps.signal);
  const wanted = name.replace(/^library\//i, '');
  const model =
    models.find(entry => entry.name === name || entry.name === wanted) ??
    models.find(entry => entry.name === `${wanted}:latest`);
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
    acceptLicense: Boolean(argv['accept-license']),
    includeAbliterated: Boolean(argv['include-abliterated']),
  };
  try {
    switch (subcommand) {
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

export async function handleModelsCommand(subcommand: string | undefined, argv: ModelsCommandArgs): Promise<number> {
  const configStore = new ConfigStore();
  const config = await configStore.load();
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
      curated: () => loadCuratedManifest(message => console.error(message)),
      hardware: () => probeHardware(),
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onSigint);
  }
}
