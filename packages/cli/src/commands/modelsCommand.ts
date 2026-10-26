/**
 * External models command (b4m models ls|search|show|pull|rm|use).
 * Finds, downloads and selects local models on the configured Ollama runtime, with Hugging Face GGUF
 * repos resolved through @bike4mind/local-models. Runs outside the interactive CLI session.
 */

import { createInterface } from 'readline';
import {
  HubAccessError,
  HuggingFaceHub,
  ModelNotFoundError,
  OllamaRuntime,
  detectRuntimes,
  isHubRepoId,
  type DetectedRuntime,
  type HubGated,
  type HubGgufBuild,
  type HubModelDetail,
  type LocalRuntime,
  type OllamaRefIssue,
} from '@bike4mind/local-models';
import { ConfigStore } from '../storage/ConfigStore.js';
import { sanitizeTerminalText } from '../utils/sanitizeTerminalText.js';

interface ModelsCommandArgs {
  _: (string | number)[];
  name?: string;
  ref?: string;
  repo?: string;
  query?: string | string[];
  yes?: boolean;
  'accept-license'?: boolean;
  'ollama-host'?: string;
  'output-format'?: string;
  [key: string]: unknown;
}

export type HubClient = Pick<HuggingFaceHub, 'endpoint' | 'search' | 'getModel' | 'verifyOllamaRef'>;

export type RuntimeSource = 'flag' | 'env' | 'config' | 'detected';

export interface RuntimeTarget {
  runtime: LocalRuntime;
  source: RuntimeSource;
}

export interface ModelsConfig {
  defaultModel: string | undefined;
  ollamaHost: string | undefined;
  save(patch: { defaultModel?: string; ollamaHost?: string }): Promise<void>;
}

export interface ModelsDeps {
  hub: () => HubClient;
  resolveRuntime: () => Promise<RuntimeTarget>;
  config: ModelsConfig;
  confirm: (question: string) => Promise<boolean>;
  isTTY: boolean;
  log: (line: string) => void;
  /** Rewrites one terminal line; only used when `isTTY`. */
  progress: { update: (line: string) => void; end: () => void };
  /** Aborted on Ctrl-C. */
  signal: AbortSignal;
}

export interface ModelsOptions {
  json: boolean;
  yes: boolean;
  acceptLicense: boolean;
}

export type PullTarget = { kind: 'hub'; repo: string; tag: string | null } | { kind: 'ollama'; name: string };

export type PullResult = 'pulled' | 'declined' | 'cancelled';

/** Exit code for a run stopped by Ctrl-C (128 + SIGINT). */
export const EXIT_CANCELLED = 130;

const DEFAULT_QUANT = 'Q4_K_M';
const SEARCH_LIMIT = 20;
const PROGRESS_INTERVAL_MS = 100;

const PERMISSIVE_LICENSES = new Set([
  '0bsd',
  'apache-2.0',
  'bsd',
  'bsd-2-clause',
  'bsd-3-clause',
  'bsd-3-clause-clear',
  'bsl-1.0',
  'cc0-1.0',
  'isc',
  'mit',
  'unlicense',
  'zlib',
]);

const REF_ISSUES: Record<OllamaRefIssue, string> = {
  split: 'split into shards, which Ollama cannot pull',
  incomplete: 'some shards are missing',
  'no-quant-label': 'the file name has no quant label',
  'unsupported-name': 'Ollama does not accept this repo or file name',
  'pinned-revision': 'not on the main branch',
  ambiguous: 'an earlier file answers the same tag; pull asks the registry',
};

// `ambiguous` builds can still pull: verifyOllamaRef asks the registry which file the tag serves.
const UNPULLABLE: ReadonlySet<OllamaRefIssue> = new Set([
  'split',
  'incomplete',
  'no-quant-label',
  'unsupported-name',
  'pinned-revision',
]);

const clean = (text: string | null | undefined): string => sanitizeTerminalText(text ?? '');

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '-';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

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

function runtimeLabel({ runtime, source }: RuntimeTarget): string {
  const name = runtime.kind === 'ollama' ? 'Ollama' : 'OpenAI-compatible server';
  return `${name} at ${runtime.baseUrl}${source === 'detected' ? ' (detected)' : ''}`;
}

export function licenseFor(
  detail: Pick<HubModelDetail, 'id' | 'licenses' | 'licenseName' | 'licenseLink'>,
  endpoint: string
): { label: string; link: string; restricted: boolean } {
  const id = detail.licenses[0]?.toLowerCase() ?? null;
  const label = (id === 'other' || !id ? detail.licenseName : null) ?? detail.licenses[0] ?? 'none declared';
  const raw = detail.licenseLink;
  const link = !raw
    ? `${endpoint}/${detail.id}`
    : /^https?:\/\//i.test(raw)
      ? raw
      : `${endpoint}/${detail.id}/blob/main/${raw.replace(/^\.?\//, '')}`;
  return { label: clean(label), link: clean(link), restricted: !id || !PERMISSIVE_LICENSES.has(id) };
}

function gatedMessage(repo: string, endpoint: string): string {
  return [
    `${repo} is gated: the Hugging Face account must be granted access before anything can be downloaded.`,
    `  1. Request access at ${endpoint}/${repo}`,
    '  2. Set HF_TOKEN to a token of that account',
    "  3. Add your Ollama public key (~/.ollama/id_ed25519.pub) under Hugging Face Settings > SSH keys, so Ollama's own download is allowed",
  ].join('\n');
}

/** `hf.co/owner/repo[:tag]` and `owner/repo[:tag]` are Hugging Face repos; anything else is an Ollama name. */
export function parsePullTarget(input: string): PullTarget {
  const trimmed = input.trim();
  const hf = /^(?:https?:\/\/)?(?:hf\.co|huggingface\.co)\/(.+)$/i.exec(trimmed);
  const rest = hf ? hf[1] : trimmed;
  const colon = rest.lastIndexOf(':');
  const hasTag = colon > rest.lastIndexOf('/');
  const path = hasTag ? rest.slice(0, colon) : rest;
  const tag = hasTag ? rest.slice(colon + 1) : null;
  const segments = path.split('/');
  if (hf || (segments.length === 2 && !segments[0].includes('.'))) {
    if (!isHubRepoId(path) || tag === '')
      throw new Error(`Not a Hugging Face repo: ${input} (expected owner/name[:quant])`);
    return { kind: 'hub', repo: path, tag };
  }
  return { kind: 'ollama', name: trimmed };
}

/** Matches the tag against each build's planned ref, then its quant label; no tag means Q4_K_M. */
export function pickBuild(builds: HubGgufBuild[], tag: string | null): HubGgufBuild | undefined {
  const wanted = (tag ?? DEFAULT_QUANT).toUpperCase();
  return (
    builds.find(build => build.ollamaRef?.slice(build.ollamaRef.lastIndexOf(':') + 1).toUpperCase() === wanted) ??
    builds.find(build => build.quant === wanted)
  );
}

export async function listModels(deps: ModelsDeps, opts: ModelsOptions): Promise<number> {
  const target = await deps.resolveRuntime();
  const { runtime } = target;
  const [models, loaded] = await Promise.all([
    runtime.list(),
    runtime.capabilities.reportsLoaded ? runtime.loaded().catch(() => []) : Promise.resolve([]),
  ]);
  const loadedNames = new Set(loaded.map(model => model.name));
  const rows = models.map(model => ({
    ...model,
    loaded: loadedNames.has(model.name),
    default: model.name === deps.config.defaultModel,
  }));

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
  if (opts.json) {
    deps.log(JSON.stringify(page, null, 2));
    return 0;
  }
  if (page.models.length === 0) {
    deps.log(`No GGUF models on Hugging Face match "${clean(query)}".`);
    return 0;
  }
  const lines = table([
    ['REPO', 'DOWNLOADS', 'LIKES', 'LICENSE', 'GATED'],
    ...page.models.map(model => [
      clean(model.id),
      formatCount(model.downloads),
      formatCount(model.likes),
      clean(model.licenses[0]) || '-',
      formatGated(model.gated),
    ]),
  ]);
  for (const line of lines) deps.log(line);
  deps.log('');
  deps.log('Builds and sizes: b4m models show <repo>');
  return 0;
}

export async function showModel(repo: string, deps: ModelsDeps, opts: ModelsOptions): Promise<number> {
  if (!isHubRepoId(repo)) throw new Error(`Not a Hugging Face repo: ${repo} (expected owner/name)`);
  const hub = deps.hub();
  const detail = await hub.getModel(repo, { signal: deps.signal });
  if (opts.json) {
    deps.log(JSON.stringify(detail, null, 2));
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
  const suggested = pickBuild(detail.builds, null) ?? detail.builds.find(build => build.ollamaRef);
  if (suggested?.quant) {
    deps.log('');
    deps.log(`Pull one with: b4m models pull ${id}:${clean(suggested.quant)}`);
  }
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

async function requirePullable(deps: ModelsDeps): Promise<RuntimeTarget> {
  const target = await deps.resolveRuntime();
  if (!target.runtime.capabilities.canPull) throw new Error(`${runtimeLabel(target)} cannot download models.`);
  return target;
}

export async function pullModel(input: string, deps: ModelsDeps, opts: ModelsOptions): Promise<PullResult> {
  const parsed = parsePullTarget(input);
  if (parsed.kind === 'ollama') {
    const target = await requirePullable(deps);
    const base = parsed.name.replace(/:.*$/, '');
    deps.log(`Model:    ${clean(parsed.name)} (Ollama registry)`);
    deps.log(`Runtime:  ${runtimeLabel(target)}`);
    if (!base.includes('/')) deps.log(`Size and license: https://ollama.com/library/${clean(base)}`);
    deps.log('Ollama reports the download size once the pull starts.');
    if (!(await confirmDownload(`Download ${clean(parsed.name)}? [y/N] `, deps, opts))) return 'declined';
    return pullWithProgress(target, parsed.name, deps);
  }

  const hub = deps.hub();
  const detail = await hub.getModel(parsed.repo, { signal: deps.signal });
  const id = clean(detail.id);
  if (detail.gated && detail.canDownload !== true) throw new Error(gatedMessage(id, hub.endpoint));

  const build = pickBuild(detail.builds, parsed.tag);
  if (!build) {
    const quants = [...new Set(detail.builds.map(entry => entry.quant).filter(Boolean))].map(clean);
    throw new Error(
      quants.length === 0
        ? `${id} has no GGUF builds.`
        : `${id} has no ${clean(parsed.tag ?? DEFAULT_QUANT)} build. Pick one of: ${quants.join(', ')} (b4m models pull ${id}:<QUANT>)`
    );
  }
  if (build.ollamaRefIssue && UNPULLABLE.has(build.ollamaRefIssue)) {
    throw new Error(`Ollama cannot pull ${id} ${clean(build.quant)}: ${REF_ISSUES[build.ollamaRefIssue]}.`);
  }

  const target = await requirePullable(deps);
  const license = licenseFor(detail, hub.endpoint);
  const projector = Math.max(0, ...detail.projectors.map(entry => entry.sizeBytes));
  deps.log(`Model:    ${id} (${clean(build.quant)})`);
  deps.log(`File:     ${build.files.map(file => clean(file.path)).join(', ')}`);
  deps.log(
    `Size:     ${formatBytes(build.sizeBytes)}${projector > 0 ? ` plus a vision projector of up to ${formatBytes(projector)}` : ''}`
  );
  deps.log(`License:  ${license.label}`);
  deps.log(`Runtime:  ${runtimeLabel(target)}`);

  if (license.restricted) {
    deps.log('');
    deps.log(`This model is under the ${license.label} license, which is not a permissive open-source license.`);
    deps.log(`Read it before downloading: ${license.link}`);
    if (!opts.acceptLicense) {
      if (!deps.isTTY) throw new Error('Re-run with --accept-license once you have read and accepted the license.');
      if (!(await deps.confirm(`Do you accept the ${license.label} license? [y/N] `))) return 'declined';
    }
  }
  if (!(await confirmDownload(`Download ${formatBytes(build.sizeBytes)}? [y/N] `, deps, opts))) return 'declined';

  let ref: string | null;
  try {
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
  const target = await deps.resolveRuntime();
  if (!target.runtime.capabilities.canRemove) throw new Error(`${runtimeLabel(target)} cannot remove models.`);
  if (!opts.yes) {
    if (!deps.isTTY) throw new Error('Re-run with --yes to remove without a prompt.');
    if (!(await deps.confirm(`Remove ${clean(name)} from ${runtimeLabel(target)}? [y/N] `))) {
      deps.log('Aborted');
      return 0;
    }
  }
  try {
    await target.runtime.remove(name);
  } catch (error) {
    if (error instanceof ModelNotFoundError)
      throw new Error(`No model named ${clean(name)} on ${runtimeLabel(target)}.`);
    throw error;
  }
  deps.log(`Removed ${clean(name)}.`);
  if (deps.config.defaultModel === name) {
    deps.log('It was your default model; pick another with: b4m models use <name>');
  }
  return 0;
}

export async function useModel(name: string, deps: ModelsDeps): Promise<number> {
  const target = await deps.resolveRuntime();
  const { runtime } = target;
  // The chat backend (OllamaBackend in @bike4mind/llm-adapters) only talks to Ollama.
  if (runtime.kind !== 'ollama')
    throw new Error(`The CLI chats with local models through Ollama; ${runtimeLabel(target)} is not Ollama.`);
  const models = await runtime.list();
  const model = models.find(entry => entry.name === name) ?? models.find(entry => entry.name === `${name}:latest`);
  if (!model) throw new Error(`No model named ${clean(name)} on ${runtimeLabel(target)}. See: b4m models ls`);
  await deps.config.save({
    defaultModel: model.name,
    ...(deps.config.ollamaHost !== runtime.baseUrl && { ollamaHost: runtime.baseUrl }),
  });
  deps.log(`Default model: ${clean(model.name)} on Ollama at ${runtime.baseUrl}`);
  deps.log('Start chatting with: b4m');
  return 0;
}

export async function resolveRuntimeTarget(
  hosts: { flag?: string; env?: string; config?: string },
  detect: () => Promise<DetectedRuntime[]> = () => detectRuntimes(),
  createOllama: (baseUrl: string) => LocalRuntime = baseUrl => new OllamaRuntime({ baseUrl })
): Promise<RuntimeTarget> {
  const configured: [RuntimeSource, string | undefined][] = [
    ['flag', hosts.flag],
    ['env', hosts.env],
    ['config', hosts.config],
  ];
  const chosen = configured.find(([, host]) => host);
  if (chosen?.[1]) {
    const runtime = createOllama(chosen[1]);
    const health = await runtime.health();
    if (!health.ok) throw new Error(`Ollama at ${runtime.baseUrl} is unreachable: ${health.error}`);
    return { runtime, source: chosen[0] };
  }
  const detected = (await detect()).filter(entry => entry.health.ok);
  const pick = detected.find(entry => entry.runtime.kind === 'ollama') ?? detected[0];
  if (!pick) {
    throw new Error(
      'No local model runtime found. Start Ollama (https://ollama.com/download), or point the CLI at one with: ' +
        'b4m models ls --ollama-host http://<host>:11434'
    );
  }
  return { runtime: pick.runtime, source: 'detected' };
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
    if (error instanceof HubAccessError && error.reason === 'gated') {
      throw new Error(gatedMessage(clean(error.repo), deps.hub().endpoint));
    }
    if (error instanceof HubAccessError) {
      throw new Error(`Hugging Face refused ${clean(error.repo)}: check that HF_TOKEN is valid and can read it.`);
    }
    throw new Error(clean(error instanceof Error ? error.message : String(error)));
  }
}

function confirmOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>(resolve => {
    // Ctrl-C at a prompt arrives here (readline holds the terminal in raw mode) and counts as "no".
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      rl.close();
      resolve(false);
    });
    rl.question(question, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
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
  if (flagHost === '') {
    if (models.ollamaHost) {
      await models.save({ ollamaHost: undefined });
      console.log('Cleared the saved Ollama host.');
    }
  } else if (flagHost) {
    const { baseUrl } = new OllamaRuntime({ baseUrl: flagHost });
    if (baseUrl !== models.ollamaHost) {
      await models.save({ ollamaHost: baseUrl });
      console.log(`Saved Ollama host ${baseUrl}`);
    }
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
      resolveRuntime: () =>
        resolveRuntimeTarget({
          flag: flagHost || undefined,
          env: process.env.B4M_OLLAMA_HOST,
          config: models.ollamaHost,
        }),
      config: models,
      confirm: confirmOnTerminal,
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      log: line => console.log(line),
      progress: {
        update: line => process.stdout.write(`\r\x1b[2K${line}`),
        end: () => process.stdout.write('\n'),
      },
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onSigint);
  }
}
