import {
  PLATFORM_USAGE_OWNER_ID,
  PLATFORM_USAGE_OWNER_TYPE,
  getToolSideEffects,
  type IUsageEventInput,
  type IUsageEventRepository,
} from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

/**
 * The dry run behind a skill template's example (apps/client/server/skillMarket/templateExample.ts).
 * The run is public, so no tool may touch a real account or the author's private data: those tools
 * return made-up placeholder data instead, and every call is recorded as a short step line.
 */

export interface ExampleRunStep {
  label: string;
  simulated: boolean;
}

/** Passed to ChatCompletionProcess.process only by server code; no request body can carry it. */
export interface ExampleRunMode {
  onStep: (step: ExampleRunStep) => void;
  /**
   * The approved version's skill. A `/name` mention of it expands from this, not from the author's
   * live skill row or a same-named shared skill (SkillsFeature).
   */
  skill?: { name: string; body: string };
  /** Ends the turn at the run's deadline; the caller settles the quest. */
  abortSignal?: AbortSignal;
  /** The skill listing whose template example this is, stamped on the run's platform-paid usage rows. */
  listingId?: string;
}

export type ExampleRunToolMode = 'real' | 'simulated';

/** Built-in tools that read the author's own workspace (files, knowledge, notebooks, skills). */
const WORKSPACE_READS: ReadonlySet<string> = new Set([
  'search_knowledge_base',
  'retrieve_knowledge_content',
  'count_knowledge_base',
  'describe_knowledge_base',
  'list_my_data_lakes',
  'skill',
  'file_read',
  'glob_files',
  'grep_search',
  'recent_changes',
  'check_shell_output',
  'list_background_shells',
  'lattice_query',
  'lattice_explain',
  'list_curated_files',
  'notebook_status',
  'mission_status',
]);

/**
 * Generation tools that store their output for the author but reach no outside account. A subagent
 * runs too: its own tools pass through this policy (ToolBuilder's wrapChildTools).
 */
const REAL_GENERATION: ReadonlySet<string> = new Set([
  'image_generation',
  'edit_image',
  'video_generation',
  'music_generation',
  'audio_generation',
  'delegate_to_agent',
]);

/**
 * Whether a tool runs for real in an example run. Connector (MCP, `server__tool`) tools are always
 * simulated, reads included; so is anything undeclared or with outside side effects.
 */
export function exampleRunToolMode(name: string): ExampleRunToolMode {
  if (name.includes('__')) return 'simulated';
  if (WORKSPACE_READS.has(name)) return 'simulated';
  if (REAL_GENERATION.has(name)) return 'real';
  const sideEffects = getToolSideEffects(name);
  return sideEffects === 'none' || sideEffects === 'local' ? 'real' : 'simulated';
}

const READ_VERBS = new Set([
  'search',
  'list',
  'get',
  'read',
  'fetch',
  'retrieve',
  'find',
  'query',
  'describe',
  'count',
]);

const VERB_LABELS: Record<string, string> = {
  search: 'Searched',
  list: 'Listed',
  get: 'Read',
  read: 'Read',
  fetch: 'Read',
  retrieve: 'Read',
  find: 'Found',
  query: 'Queried',
  describe: 'Described',
  count: 'Counted',
  create: 'Created',
  add: 'Added',
  update: 'Updated',
  edit: 'Updated',
  set: 'Updated',
  delete: 'Deleted',
  remove: 'Removed',
  post: 'Posted',
  send: 'Sent',
  comment: 'Commented on',
  reply: 'Replied to',
  publish: 'Published',
  close: 'Closed',
  merge: 'Merged',
  assign: 'Assigned',
  label: 'Labeled',
  generate: 'Generated',
};

/** Connectors whose placeholder workspace reads best as a repository. */
const REPO_SERVERS = new Set(['github', 'gitlab', 'bitbucket']);

export const EXAMPLE_PLACEHOLDER = {
  org: 'example-org',
  repository: 'example-org/app',
  user: 'example-user',
  email: 'user@example.com',
} as const;

function splitToolName(name: string): { server: string | null; words: string[] } {
  const at = name.indexOf('__');
  const server = at > 0 ? name.slice(0, at) : null;
  const tool = at > 0 ? name.slice(at + 2) : name;
  return {
    server,
    words: tool
      .split(/[_\-\s]+/)
      .filter(Boolean)
      .map(w => w.toLowerCase()),
  };
}

/** Made-up data a simulated tool returns: never a real account, repo or person. */
export function simulatedToolResult(name: string): string {
  const { words } = splitToolName(name);
  const reads = READ_VERBS.has(words[0] ?? '');
  const item = (n: number) => ({
    id: `example-${n}`,
    title: `Example item ${n}`,
    owner: EXAMPLE_PLACEHOLDER.user,
    repository: EXAMPLE_PLACEHOLDER.repository,
    url: `https://example.com/${EXAMPLE_PLACEHOLDER.repository}/${n}`,
  });
  return JSON.stringify({
    simulated: true,
    note:
      'Example run: no real account was read or changed. The data below is placeholder sample data; ' +
      'use it as the result of this step.',
    result: reads
      ? { items: [item(1), item(2)] }
      : { status: 'ok', id: 'example-1', repository: EXAMPLE_PLACEHOLDER.repository, user: EXAMPLE_PLACEHOLDER.user },
  });
}

const STEP_LABEL_MAX = 80;

const clip = (label: string) => (label.length > STEP_LABEL_MAX ? `${label.slice(0, STEP_LABEL_MAX - 3)}...` : label);

const param = (parameters: unknown, key: string): unknown =>
  typeof parameters === 'object' && parameters !== null ? (parameters as Record<string, unknown>)[key] : undefined;

function sizeOf(parameters: unknown): string | null {
  const width = param(parameters, 'width');
  const height = param(parameters, 'height');
  if (typeof width === 'number' && typeof height === 'number') return `${width}x${height}`;
  const size = param(parameters, 'size');
  return typeof size === 'string' && /^\d{2,5}x\d{2,5}$/.test(size) ? size : null;
}

function builtInLabel(name: string, parameters: unknown): string | null {
  const size = sizeOf(parameters);
  switch (name) {
    case 'image_generation':
      return size ? `Generated a ${size} image` : 'Generated an image';
    case 'edit_image':
      return 'Edited an image';
    case 'video_generation':
      return size ? `Rendered ${size} video` : 'Rendered a video';
    case 'music_generation':
      return 'Composed a music track';
    case 'audio_generation':
      return 'Generated audio';
    case 'web_search': {
      const query = param(parameters, 'query');
      return typeof query === 'string' && query.trim() ? `Searched the web for "${query.trim()}"` : 'Searched the web';
    }
    case 'web_fetch': {
      const url = param(parameters, 'url');
      try {
        return typeof url === 'string' ? `Read ${new URL(url).hostname}` : 'Read a web page';
      } catch {
        return 'Read a web page';
      }
    }
    case 'deep_research':
      return 'Researched the topic';
    case 'delegate_to_agent':
      return 'Handed a subtask to an agent';
    case 'math_evaluate':
      return 'Calculated a result';
    case 'mermaid_chart':
      return 'Drew a diagram';
    case 'recharts':
      return 'Drew a chart';
    default:
      return null;
  }
}

/** A short human line for one tool call, e.g. "Searched issues in example-org/app". */
export function exampleStepLabel(name: string, parameters: unknown): string {
  const known = builtInLabel(name, parameters);
  if (known) return clip(known);
  const { server, words } = splitToolName(name);
  const [verb, ...rest] = words;
  const head = (verb && VERB_LABELS[verb]) ?? 'Ran';
  const object = (verb && VERB_LABELS[verb] ? rest : words).join(' ');
  const where = server
    ? ` in ${REPO_SERVERS.has(server.toLowerCase()) ? EXAMPLE_PLACEHOLDER.repository : server.replace(/[_-]+/g, ' ')}`
    : '';
  return clip(`${head}${object ? ` ${object}` : ''}${where}`);
}

/** Wraps every tool with the example-run policy and records one step per call. */
export function applyExampleRunPolicy(tools: ICompletionOptionTools[], mode: ExampleRunMode): ICompletionOptionTools[] {
  return tools.map(tool => {
    const name = tool.toolSchema.name;
    const simulated = exampleRunToolMode(name) === 'simulated';
    return {
      ...tool,
      toolFn: async (parameters, apiKey) => {
        mode.onStep({ label: exampleStepLabel(name, parameters), simulated });
        return simulated ? simulatedToolResult(name) : tool.toolFn(parameters, apiKey);
      },
    };
  });
}

type ApiKeyReads = { findByUserIdAndType: unknown; findByUserIdAndTypes: unknown };

/**
 * The tool db with no user-saved provider keys, so key resolvers (getEffectiveApiKey in the image
 * tools) fall through to the platform's admin-setting keys.
 */
export function withoutUserApiKeys<D extends { apiKeys: ApiKeyReads }>(db: D): D {
  const apiKeys = new Proxy(db.apiKeys, {
    get(target, prop, receiver) {
      if (prop === 'findByUserIdAndType') return async () => null;
      if (prop === 'findByUserIdAndTypes') return async () => [];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...db, apiKeys };
}

type UsageRecorder = Pick<IUsageEventRepository, 'record'>;

/**
 * The run's usage rows as platform-paid: owned by the platform, not the author or their org, and
 * never charged, so no per-user/per-org spend view, cap, budget or freeze counts them.
 */
export function platformPaidUsageEvent(event: IUsageEventInput, listingId: string | undefined): IUsageEventInput {
  return {
    ...event,
    userId: PLATFORM_USAGE_OWNER_ID,
    ownerId: PLATFORM_USAGE_OWNER_ID,
    ownerType: PLATFORM_USAGE_OWNER_TYPE,
    projectId: undefined,
    creditsCharged: 0,
    writtenOffCredits: undefined,
    reservedCredits: undefined,
    fundingBreakdown: undefined,
    apiKeyId: undefined,
    // Platform-initiated, so user-activity analytics that skip 'system' traffic skip these rows.
    source: 'system',
    platformPaid: { reason: 'template_example_run', listingId },
  };
}

function withPlatformPaidUsage<R extends UsageRecorder>(repo: R, listingId: string | undefined): R {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'record')
        return (event: IUsageEventInput) => target.record(platformPaidUsageEvent(event, listingId));
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

type ExampleToolDb = { apiKeys: ApiKeyReads; usageEvents?: UsageRecorder; operationalBilling?: unknown };

/**
 * The tool db of an example run: platform keys, tool usage rows re-owned to the platform, and no
 * operational billing, so a tool's own model calls never debit the author.
 */
function exampleToolDb<D extends ExampleToolDb>(db: D, exampleRun: ExampleRunMode): D {
  return {
    ...withoutUserApiKeys(db),
    usageEvents: db.usageEvents && withPlatformPaidUsage(db.usageEvents, exampleRun.listingId),
    operationalBilling: undefined,
  };
}

/**
 * Every point where ChatCompletionProcess.process differs for an example run, so each one is tested
 * here (exampleRunTools.test.ts). Without `exampleRun` each is the normal turn's behavior.
 */
export function exampleRunWiring(exampleRun: ExampleRunMode | undefined) {
  return {
    /** Null makes getEffectiveLLMApiKeys resolve the platform's admin-setting keys only. */
    apiKeyOwner: (userId: string): string | null => (exampleRun ? null : userId),
    /** The platform pays, so no credit reservation, settlement or free-tier model gate. */
    enforceCredits: (setting: boolean): boolean => !exampleRun && setting,
    payerGates: !exampleRun,
    researchModeAllowed: !exampleRun,
    tools: (tools: ICompletionOptionTools[]): ICompletionOptionTools[] =>
      exampleRun ? applyExampleRunPolicy(tools, exampleRun) : tools,
    childTools: exampleRun
      ? (tools: ICompletionOptionTools[]): ICompletionOptionTools[] => applyExampleRunPolicy(tools, exampleRun)
      : undefined,
    toolDb: <D extends ExampleToolDb>(db: D): D => (exampleRun ? exampleToolDb(db, exampleRun) : db),
    /**
     * The settlement usage rows still write when credits are off, re-owned to the platform, so the
     * run's model cost shows in platform reporting without touching the author's spend.
     */
    recordsPlatformUsage: !!exampleRun,
    usageEvents: <R extends UsageRecorder>(repo: R | undefined): R | undefined =>
      exampleRun && repo ? withPlatformPaidUsage(repo, exampleRun.listingId) : repo,
    pinnedSkill: exampleRun?.skill,
  };
}
