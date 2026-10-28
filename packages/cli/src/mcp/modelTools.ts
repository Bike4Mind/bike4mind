import { z } from 'zod';
import {
  HUGGING_FACE_SSH_KEYS_URL,
  HuggingFaceHub,
  isAbliteratedModel,
  type InstalledModel,
  type PullOptions,
} from '@bike4mind/local-models';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ElicitRequestFormParams,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { readOllamaManifest } from '../commands/ollamaRegistry.js';
import {
  CancelledError,
  NO_LICENSE,
  abortable,
  buildTag,
  clean,
  formatBytes,
  hiddenAbliteratedMessage,
  hubAccessMessage,
  listInstalled,
  normalizeModelName,
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
  type ModelSourceDeps,
  type PullPlan,
  type RuntimeTarget,
} from '../models/localModels.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import { errorResult, toResult } from './tools.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ModelToolsDeps extends Omit<ModelSourceDeps, 'signal'> {
  defaultModel: () => Promise<string | undefined>;
}

/** How long the user has to answer an elicitation prompt (ms). */
const ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 500;
const SEARCH_LIMIT = 20;

export const MODEL_TOOL_NAMES = ['models_list', 'models_search', 'models_pull', 'models_remove'] as const;

const searchShape = {
  query: z.string().trim().min(1).max(200).describe('Search text, e.g. "qwen2.5 0.5b"'),
  limit: z.number().int().min(1).max(50).default(SEARCH_LIMIT).describe('Maximum repos to search'),
  includeAbliterated: z
    .boolean()
    .default(false)
    .describe(
      'Also return abliterated or uncensored builds, labelled notRecommended and listed after every other hit. Pass true only when the user asks for them.'
    ),
};

const pullShape = {
  ref: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe('An Ollama name (model[:tag]) or a Hugging Face GGUF repo (owner/repo[:quant], Q4_K_M by default)'),
};

const removeShape = {
  name: z.string().trim().min(1).max(300).describe('The installed model name, as models_list shows it'),
};

/** What the user must see before approving a pull. */
function pullSummary(plan: PullPlan) {
  const runtime = runtimeLabel(plan.target);
  if (plan.kind === 'ollama') {
    const { license } = plan;
    return {
      source: 'ollama' as const,
      model: clean(plan.name),
      sizeBytes: plan.manifest.sizeBytes,
      size: formatBytes(plan.manifest.sizeBytes),
      revision: null,
      digest: shortDigest(plan.manifest.digest),
      licenses: [license.label],
      license: { label: license.label, link: license.link, permissive: !license.restricted },
      acknowledgementRequired: license.restricted,
      runtime,
    };
  }
  const { detail, build, license } = plan;
  return {
    source: 'huggingface' as const,
    model: plan.id,
    label: clean(build.label),
    files: build.files.map(file => ({ path: clean(file.path), sizeBytes: file.sizeBytes })),
    sizeBytes: build.sizeBytes,
    size: formatBytes(build.sizeBytes),
    ...(plan.projectorBytes > 0 && {
      visionProjectorUpToBytes: plan.projectorBytes,
      visionProjectorUpTo: formatBytes(plan.projectorBytes),
    }),
    revision: clean(detail.revision),
    licenses: detail.licenses.map(clean),
    license: { label: license.label, link: license.link, permissive: !license.restricted },
    acknowledgementRequired: license.restricted,
    gated: detail.gated,
    runtime,
    ...(isAbliteratedModel(detail) && { caution: 'This is an abliterated or uncensored build.' }),
    ...(detail.ollamaNeedsSshKey && {
      sshKeyNote: `Ollama downloads ${detail.private ? 'private' : 'gated'} repos with its own key: add ~/.ollama/id_ed25519.pub of the Ollama host at ${HUGGING_FACE_SSH_KEYS_URL} if you have not.`,
    }),
  };
}

type PullSummary = ReturnType<typeof pullSummary>;

/** The download size, plus the vision projector Ollama's Hugging Face registry adds to the pull. */
function sizeText(summary: PullSummary): string {
  return 'visionProjectorUpTo' in summary && summary.visionProjectorUpTo
    ? `${summary.size} plus a vision projector of up to ${summary.visionProjectorUpTo}`
    : summary.size;
}

function gatedLine(summary: PullSummary): string[] {
  if (!('gated' in summary) || !summary.gated) return [];
  return [`Gated: yes (${summary.gated === 'manual' ? 'manual approval' : 'automatic approval'}), access granted.`];
}

function licenseSentence(summary: PullSummary): string {
  const { license } = summary;
  if (license.permissive) return `License: ${license.label}.`;
  if (license.label === NO_LICENSE) return `License: ${NO_LICENSE}. Read the model page first: ${license.link}`;
  return `License: ${license.label}, not all permissive. Read ${license.link} before accepting.`;
}

function pullMessage(summary: PullSummary): string {
  return [
    `Download ${summary.model}${'label' in summary ? ` ${summary.label}` : ''} (${sizeText(summary)}) to ${summary.runtime}?`,
    ...('files' in summary ? [`File: ${summary.files.map(file => file.path).join(', ')}`] : []),
    ...(summary.revision ? [`Revision: ${summary.revision}`] : []),
    ...('digest' in summary ? [`Digest: ${summary.digest}`] : []),
    licenseSentence(summary),
    ...gatedLine(summary),
    ...('sshKeyNote' in summary && summary.sshKeyNote ? [summary.sshKeyNote] : []),
    ...('caution' in summary && summary.caution ? [summary.caution] : []),
  ].join('\n');
}

function pullElicitation(summary: PullSummary): ElicitRequestFormParams {
  return {
    mode: 'form',
    message: pullMessage(summary),
    requestedSchema: {
      type: 'object',
      properties: {
        download: { type: 'boolean', title: `Download ${sizeText(summary)}`, default: false },
        ...(summary.acknowledgementRequired && {
          acceptLicense: {
            type: 'boolean',
            title: `I have read and accept the license: ${summary.license.label}`,
            description: summary.license.link,
            default: false,
          },
        }),
      },
      required: summary.acknowledgementRequired ? ['download', 'acceptLicense'] : ['download'],
    },
  };
}

const shellWord = (word: string) => (/^[\w.:/@-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** The `b4m models` command that does the same on the same runtime, asking the user in their terminal. */
function terminalCommand(target: RuntimeTarget, subcommand: 'pull' | 'rm', subject: string): string {
  // A host from the server's environment is not in the user's shell; --ollama-host would save it to their config.
  const host = target.source === 'env' ? `B4M_OLLAMA_HOST=${shellWord(target.runtime.baseUrl)} ` : '';
  return `${host}b4m models ${subcommand} ${shellWord(subject)}`;
}

/** The ref `b4m models pull` resolves to the same build. */
function pullRef(plan: PullPlan): string {
  if (plan.kind === 'ollama') return plan.name;
  return `${plan.detail.id}:${buildTag(plan.build)}`;
}

function pullProgress(extra: Extra): PullOptions['onProgress'] {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let sent = 0;
  let lastStatus = '';
  let lastSent = 0;
  return ({ status, completedBytes, totalBytes }) => {
    const now = Date.now();
    if (status === lastStatus && now - lastSent < PROGRESS_INTERVAL_MS) return;
    lastStatus = status;
    lastSent = now;
    // The spec wants progress to rise; Ollama's sum can dip when it announces a new layer.
    sent = Math.max(sent, completedBytes);
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: sent, ...(totalBytes ? { total: totalBytes } : {}), message: clean(status) },
      })
      .catch(() => {});
  };
}

function findInstalled(models: InstalledModel[], name: string): InstalledModel | undefined {
  const wanted = name.replace(/^library\//i, '');
  return (
    models.find(model => model.name === name || model.name === wanted) ??
    models.find(model => model.name === `${wanted}:latest`)
  );
}

export function localModelToolsDeps(configStore: ConfigStore | undefined): ModelToolsDeps {
  let hub: HubClient | undefined;
  return {
    hub: () => (hub ??= new HuggingFaceHub({ token: process.env.HF_TOKEN })),
    ollamaRegistry: (name, signal) => readOllamaManifest(name, signal),
    resolveRuntime: async () =>
      resolveRuntimeTarget({ env: process.env.B4M_OLLAMA_HOST, config: (await configStore?.load())?.ollamaHost }),
    defaultModel: async () => (await configStore?.load())?.defaultModel,
  };
}

/**
 * Register models_list, models_search, models_pull and models_remove: the `b4m models` operations on the
 * user's local runtime. Pull and remove act only on an answer the user gives through MCP elicitation; no tool
 * argument approves them, so a client without elicitation gets a preview and the terminal command instead.
 * Stdio only: these change the machine the server runs on.
 */
export function registerModelTools(server: McpServer, deps: ModelToolsDeps): void {
  const canElicit = () => Boolean(server.server.getClientCapabilities()?.elicitation?.form);
  const sources = (signal: AbortSignal): ModelSourceDeps => ({ ...deps, signal });

  const run = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof CancelledError) return errorResult('Cancelled. Nothing was changed.');
      const refused = hubAccessMessage(error, () => deps.hub().endpoint);
      return errorResult(refused ?? clean(error instanceof Error ? error.message : String(error)));
    }
  };

  const ask = (params: ElicitRequestFormParams, extra: Extra) =>
    server.server.elicitInput(params, {
      signal: extra.signal,
      timeout: ELICITATION_TIMEOUT_MS,
      relatedRequestId: extra.requestId,
    });

  server.registerTool(
    'models_list',
    {
      title: 'List local models',
      description:
        "List the models installed on the user's local runtime (Ollama), with size, quantization and capabilities, and which one is loaded or the CLI default.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    extra =>
      run(async () => {
        const target = await abortable(deps.resolveRuntime(), extra.signal);
        const models = await listInstalled(target.runtime, await deps.defaultModel(), extra.signal);
        const { kind, baseUrl } = target.runtime;
        return toResult({ runtime: { kind, baseUrl, source: target.source }, models });
      })
  );

  server.registerTool(
    'models_search',
    {
      title: 'Search local models',
      description:
        "Search Hugging Face for GGUF models that run locally, with each repo's declared licenses, gated status and popularity. A repo is permissive only if every license it declares is permissive. Abliterated and uncensored builds are left out unless includeAbliterated is true; then they are marked notRecommended and come last. Never suggest or recommend one. Downloads nothing.",
      inputSchema: searchShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, extra) =>
      run(async () => {
        const page = await deps.hub().search({ query: args.query, limit: args.limit, signal: extra.signal });
        const { hits, hidden } = rankSearchHits(page.models, Boolean(args.includeAbliterated));
        return toResult({
          query: args.query,
          models: hits.map(model => ({
            id: model.id,
            licenses: model.licenses,
            gated: model.gated,
            downloads: model.downloads,
            likes: model.likes,
            updatedAt: model.updatedAt,
            baseModels: model.baseModels,
            ...(model.notRecommended && { notRecommended: model.notRecommended }),
          })),
          ...(hidden > 0 && { hidden: hiddenAbliteratedMessage(hidden) }),
          next: 'models_pull shows the build, size and every license, and asks the user before downloading.',
        });
      })
  );

  server.registerTool(
    'models_pull',
    {
      title: 'Download a local model',
      description:
        "Download a model to the user's local Ollama from an Ollama name (model[:tag]) or a Hugging Face GGUF repo (owner/repo[:quant], Q4_K_M by default). Nothing downloads without the user's own approval. When the client supports elicitation, the user is asked directly with the size, file, revision and every license, and a license that is not all permissive needs its own tick. Without elicitation nothing downloads: the result is that preview plus a `b4m models pull` command for the user to run in a terminal, where the CLI asks them. No argument of this tool approves a download. Gated repos return the steps to get access instead. Refs to hosts other than Hugging Face and Ollama are refused.",
      inputSchema: pullShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args, extra) =>
      run(async () => {
        const plan = await planPull(args.ref, sources(extra.signal), 'models_pull ref');
        const summary = pullSummary(plan);

        if (!canElicit()) {
          return toResult({
            status: 'confirm-in-terminal',
            downloaded: false,
            ...summary,
            command: terminalCommand(plan.target, 'pull', pullRef(plan)),
            userApproval:
              'Nothing was downloaded. This MCP client cannot ask the user, so the download has to be approved in a terminal: show the user the size and licenses above and give them the command. The CLI shows them again and asks before downloading' +
              (summary.acknowledgementRequired ? ', and asks them separately to accept the license.' : '.'),
          });
        }
        const answer = await ask(pullElicitation(summary), extra);
        if (answer.action !== 'accept' || answer.content?.download !== true) {
          return toResult({
            status: 'declined',
            downloaded: false,
            ...summary,
            message: 'The user declined. Nothing was downloaded.',
          });
        }
        if (summary.acknowledgementRequired && answer.content?.acceptLicense !== true) {
          return toResult({
            status: 'license-not-accepted',
            downloaded: false,
            ...summary,
            message: 'The user did not accept the license. Nothing was downloaded.',
          });
        }

        if (plan.kind === 'ollama') {
          await requireUnchangedManifest(plan.name, plan.manifest, sources(extra.signal));
        } else {
          await requireUnchangedLicenses(plan.hub, plan.detail, plan.license, extra.signal);
        }
        const ref =
          plan.kind === 'ollama'
            ? plan.name
            : await abortable(
                plan.hub.verifyOllamaRef(plan.detail, plan.build, { signal: extra.signal }),
                extra.signal
              );
        if (!ref) {
          return errorResult(
            `Hugging Face's registry does not serve this exact ${summary.model} file to Ollama, so nothing was downloaded. Pick another quant.`
          );
        }
        try {
          await plan.target.runtime.pull(ref, { signal: extra.signal, onProgress: pullProgress(extra) });
        } catch (error) {
          if (extra.signal.aborted) {
            return errorResult(
              'Pull cancelled. Nothing was installed; Ollama keeps the partial download, so pulling again resumes it.'
            );
          }
          throw error;
        }
        return toResult({ status: 'pulled', downloaded: true, installedAs: clean(ref), ...summary });
      })
  );

  server.registerTool(
    'models_remove',
    {
      title: 'Remove a local model',
      description:
        "Delete an installed model from the user's local runtime. Nothing is removed without the user's own approval: when the client supports elicitation the user is asked directly. Without elicitation nothing is removed: the result names the model and gives a `b4m models rm` command for the user to run in a terminal, where the CLI asks them. No argument of this tool approves a removal.",
      inputSchema: removeShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args, extra) =>
      run(async () => {
        const target: RuntimeTarget = await abortable(deps.resolveRuntime(), extra.signal);
        requireRemovable(target);
        const model = findInstalled(await abortable(target.runtime.list(), extra.signal), args.name);
        if (!model)
          return errorResult(`No model named ${clean(args.name)} on ${runtimeLabel(target)}. See models_list.`);
        const summary = {
          model: clean(model.name),
          sizeBytes: model.sizeBytes,
          size: formatBytes(model.sizeBytes),
          runtime: runtimeLabel(target),
        };

        if (!canElicit()) {
          return toResult({
            status: 'confirm-in-terminal',
            removed: false,
            ...summary,
            command: terminalCommand(target, 'rm', model.name),
            userApproval:
              'Nothing was removed. This MCP client cannot ask the user, so the removal has to be approved in a terminal: give the user the command, and the CLI asks them before removing.',
          });
        }
        const answer = await ask(
          {
            mode: 'form',
            message: `Remove ${summary.model} (${summary.size}) from ${summary.runtime}? Its files are deleted.`,
            requestedSchema: {
              type: 'object',
              properties: { remove: { type: 'boolean', title: `Remove ${summary.model}`, default: false } },
              required: ['remove'],
            },
          },
          extra
        );
        if (answer.action !== 'accept' || answer.content?.remove !== true) {
          return toResult({
            status: 'declined',
            removed: false,
            ...summary,
            message: 'The user declined. Nothing was removed.',
          });
        }

        await removeInstalled(target, model.name, extra.signal);
        const defaultModel = await deps.defaultModel();
        const wasDefault = !!defaultModel && normalizeModelName(defaultModel) === normalizeModelName(model.name);
        return toResult({ status: 'removed', removed: true, ...summary, wasDefault });
      })
  );
}
