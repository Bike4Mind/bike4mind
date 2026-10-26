import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HuggingFaceHub, type InstalledModel, type PullOptions } from '@bike4mind/local-models';
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
  abortable,
  clean,
  formatBytes,
  hubAccessMessage,
  isNotRecommended,
  listInstalled,
  planPull,
  removeInstalled,
  requireRemovable,
  resolveRuntimeTarget,
  runtimeLabel,
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
  now?: () => number;
  newToken?: () => string;
}

/** How long a preview's confirmationToken stays valid (ms). */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
/** How long the user has to answer an elicitation prompt (ms). */
const ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 500;
const SEARCH_LIMIT = 20;

export const MODEL_TOOL_NAMES = ['models_list', 'models_search', 'models_pull', 'models_remove'] as const;

const searchShape = {
  query: z.string().trim().min(1).max(200).describe('Search text, e.g. "qwen2.5 0.5b"'),
  limit: z.number().int().min(1).max(50).default(SEARCH_LIMIT).describe('Maximum repos to return'),
};

const confirmationToken = z
  .string()
  .max(128)
  .optional()
  .describe(
    'Only the token from an earlier preview of this same request, and only after the user approved that preview. Omit it to get a preview.'
  );

const pullShape = {
  ref: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe('An Ollama name (model[:tag]) or a Hugging Face GGUF repo (owner/repo[:quant], Q4_K_M by default)'),
  confirmationToken,
  acceptLicense: z
    .boolean()
    .optional()
    .describe(
      'true only when the preview says acknowledgementRequired and the user has said they read and accept those licenses.'
    ),
};

const removeShape = {
  name: z.string().trim().min(1).max(300).describe('The installed model name, as models_list shows it'),
  confirmationToken,
};

interface Pending {
  action: 'pull' | 'remove';
  subject: string;
  fingerprint: string;
  expiresAt: number;
}

/**
 * Single-use approvals for clients without elicitation. A token names one action on one subject, and the
 * fingerprint of what the user was shown (size, revision, licenses), so a changed model needs a new approval.
 */
class Confirmations {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly now: () => number,
    private readonly newToken: () => string
  ) {}

  issue(action: Pending['action'], subject: string, fingerprint: string): { token: string; expiresAt: string } {
    const now = this.now();
    for (const [token, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(token);
    const token = this.newToken();
    const expiresAt = now + CONFIRMATION_TTL_MS;
    this.pending.set(token, { action, subject, fingerprint, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Why `token` does not approve exactly this, or null when it does. A mismatched fingerprint spends it. */
  refusal(token: string, action: Pending['action'], subject: string, fingerprint: string): string | null {
    const entry = this.pending.get(token);
    const verb = action === 'pull' ? 'downloaded' : 'removed';
    const tool = action === 'pull' ? 'models_pull' : 'models_remove';
    if (!entry || entry.expiresAt <= this.now() || entry.action !== action) {
      return `This confirmationToken is unknown, expired or already used, so nothing was ${verb}. Call ${tool} without a token for a new preview and ask the user again.`;
    }
    if (entry.subject !== subject) {
      return `This confirmationToken was issued for ${clean(entry.subject)}, not ${clean(subject)}, so nothing was ${verb}.`;
    }
    if (entry.fingerprint !== fingerprint) {
      this.pending.delete(token);
      return `The model changed since the user approved it, so nothing was ${verb}. Call ${tool} without a token for a new preview and ask the user again.`;
    }
    return null;
  }

  spend(token: string): void {
    this.pending.delete(token);
  }
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function pullFingerprint(plan: PullPlan): string {
  const { baseUrl } = plan.target.runtime;
  if (plan.kind === 'ollama') {
    return sha256(['ollama', baseUrl, plan.name, plan.manifest.sizeBytes, plan.manifest.licenses]);
  }
  const { detail, build } = plan;
  return sha256([
    'hub',
    baseUrl,
    detail.id,
    detail.revision,
    build.ollamaRef,
    build.sizeBytes,
    build.files.map(file => [file.path, file.sizeBytes, file.sha256]),
    plan.projectorBytes,
    detail.licenses,
    detail.licenseName,
    detail.licenseLink,
  ]);
}

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
    quant: clean(build.quant),
    files: build.files.map(file => ({ path: clean(file.path), sizeBytes: file.sizeBytes })),
    sizeBytes: build.sizeBytes,
    size: formatBytes(build.sizeBytes),
    ...(plan.projectorBytes > 0 && { visionProjectorUpToBytes: plan.projectorBytes }),
    revision: clean(detail.revision),
    licenses: detail.licenses.map(clean),
    license: { label: license.label, link: license.link, permissive: !license.restricted },
    acknowledgementRequired: license.restricted,
    runtime,
    ...(isNotRecommended(detail) && { caution: 'This is an abliterated or uncensored build.' }),
    ...(detail.ollamaNeedsSshKey && {
      sshKeyNote: `Ollama downloads ${detail.private ? 'private' : 'gated'} repos with its own key: the Ollama host's ~/.ollama/id_ed25519.pub must be added to the Hugging Face account.`,
    }),
  };
}

type PullSummary = ReturnType<typeof pullSummary>;

function licenseSentence(summary: PullSummary): string {
  const { license } = summary;
  if (license.permissive) return `License: ${license.label}.`;
  if (license.label === 'none declared') return `License: none declared. Read the model page first: ${license.link}`;
  return `License: ${license.label}, not all permissive. Read ${license.link} before accepting.`;
}

function pullMessage(summary: PullSummary): string {
  return [
    `Download ${summary.model}${'quant' in summary ? ` ${summary.quant}` : ''} (${summary.size}) to ${summary.runtime}?`,
    ...('files' in summary ? [`File: ${summary.files.map(file => file.path).join(', ')}`] : []),
    ...(summary.revision ? [`Revision: ${summary.revision}`] : []),
    licenseSentence(summary),
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
        download: { type: 'boolean', title: `Download ${summary.size}`, default: false },
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
 * user's local runtime. Pull and remove act only on the user's approval, asked through MCP elicitation when the
 * client supports it, otherwise through a preview whose single-use token the caller passes back once the user
 * says yes. Stdio only: these change the machine the server runs on.
 */
export function registerModelTools(server: McpServer, deps: ModelToolsDeps): void {
  const confirmations = new Confirmations(
    deps.now ?? Date.now,
    deps.newToken ?? (() => randomBytes(18).toString('base64url'))
  );
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
        "Search Hugging Face for GGUF models that run locally, with each repo's declared licenses, gated status and popularity. A repo is permissive only if every license it declares is permissive. Never suggest a repo marked notRecommended: those are abliterated or uncensored builds. Downloads nothing.",
      inputSchema: searchShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, extra) =>
      run(async () => {
        const page = await deps.hub().search({ query: args.query, limit: args.limit, signal: extra.signal });
        return toResult({
          query: args.query,
          models: page.models.map(model => ({
            id: model.id,
            licenses: model.licenses,
            gated: model.gated,
            downloads: model.downloads,
            likes: model.likes,
            updatedAt: model.updatedAt,
            baseModels: model.baseModels,
            ...(isNotRecommended(model) && { notRecommended: 'abliterated or uncensored build' }),
          })),
          next: 'models_pull shows the build, size and every license, and asks the user before downloading.',
        });
      })
  );

  server.registerTool(
    'models_pull',
    {
      title: 'Download a local model',
      description:
        "Download a model to the user's local Ollama from an Ollama name (model[:tag]) or a Hugging Face GGUF repo (owner/repo[:quant], Q4_K_M by default). Nothing downloads without the user's approval. When the client supports elicitation the user is asked directly, with the size and every license. Otherwise the first call downloads nothing and returns a preview with a confirmationToken: show the user the model, size, every license and its link, ask them, and call again with the same ref and that token only if they say yes. When the preview has acknowledgementRequired, also pass acceptLicense: true, and only after the user has said they accept that license. Never approve on the user's behalf. Gated repos return the steps to get access instead. Refs to hosts other than Hugging Face and Ollama are refused.",
      inputSchema: pullShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args, extra) =>
      run(async () => {
        const plan = await planPull(args.ref, sources(extra.signal), 'models_pull ref');
        const summary = pullSummary(plan);
        const fingerprint = pullFingerprint(plan);

        if (canElicit()) {
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
        } else if (!args.confirmationToken) {
          const { token, expiresAt } = confirmations.issue('pull', args.ref, fingerprint);
          return toResult({
            status: 'needs-user-approval',
            downloaded: false,
            ...summary,
            confirmationToken: token,
            expiresAt,
            userApproval:
              `Nothing was downloaded. The user must approve this download: show them the model, size and licenses and ask. ` +
              `Call models_pull again with this ref and confirmationToken only if they say yes; the token works once, until ${expiresAt}.` +
              (summary.acknowledgementRequired
                ? ' This license is not all permissive or not declared, so the user must also say they read and accept it before you pass acceptLicense: true.'
                : ''),
          });
        } else {
          const refusal = confirmations.refusal(args.confirmationToken, 'pull', args.ref, fingerprint);
          if (refusal) return errorResult(refusal);
          if (summary.acknowledgementRequired && args.acceptLicense !== true) {
            return errorResult(
              `Nothing was downloaded: ${summary.license.label} needs the user's own acceptance. Ask them to read ${summary.license.link}, then pass acceptLicense: true with the same token only if they accept it.`
            );
          }
          confirmations.spend(args.confirmationToken);
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
        "Delete an installed model from the user's local runtime. Nothing is removed without the user's approval: when the client supports elicitation the user is asked directly; otherwise the first call removes nothing and returns a confirmationToken to pass back with the same name only after the user says yes. Never approve on the user's behalf.",
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
        const fingerprint = sha256([target.runtime.baseUrl, model.name, model.sizeBytes, model.modifiedAt]);

        if (canElicit()) {
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
        } else if (!args.confirmationToken) {
          const { token, expiresAt } = confirmations.issue('remove', args.name, fingerprint);
          return toResult({
            status: 'needs-user-approval',
            removed: false,
            ...summary,
            confirmationToken: token,
            expiresAt,
            userApproval: `Nothing was removed. The user must approve deleting ${summary.model}: ask them, and call models_remove again with this name and confirmationToken only if they say yes; the token works once, until ${expiresAt}.`,
          });
        } else {
          const refusal = confirmations.refusal(args.confirmationToken, 'remove', args.name, fingerprint);
          if (refusal) return errorResult(refusal);
          confirmations.spend(args.confirmationToken);
        }

        await removeInstalled(target, model.name, extra.signal);
        const wasDefault = (await deps.defaultModel()) === model.name;
        return toResult({ status: 'removed', removed: true, ...summary, wasDefault });
      })
  );
}
