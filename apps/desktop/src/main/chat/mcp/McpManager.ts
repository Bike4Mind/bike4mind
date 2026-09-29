import { MCPClient } from '@bike4mind/mcp';
import type { McpServerInput, McpServerState, McpServersState, McpServerStatus, McpToolSummary } from '@shared/mcp';
import type { ApprovalPrompt, ToolContext, ToolDefinition, ToolSchema } from '../tools/types';
import { frameDescription, frameResult, namespacedToolName, sanitizeSchema, serverSlug } from './names';
import type { McpServerRecord, McpServerStore } from './McpServerStore';

/**
 * Connecting is bounded because a stdio server that never speaks would otherwise hold the
 * turn open: the SDK's handshake has no deadline of its own, and "npx fetching a package on a
 * cold cache" and "this binary does not exist" look identical until one of them finishes.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/** Ceiling on one tool call. Long enough for a real API round trip, short enough to not hang a turn. */
const CALL_TIMEOUT_MS = 120_000;

/** Between asking a stdio child to stop and killing it. Mirrors BackgroundProcessRegistry. */
const SIGKILL_DELAY_MS = 2_000;

/** Kept per server for the UI, because a failed start usually explains itself on stderr. */
const STDERR_TAIL_LINES = 12;

/** How much of a call's arguments the approval prompt renders. See approvalFor. */
const MAX_APPROVAL_ARG_CHARS = 600;

export interface McpLogger {
  debug(message: string): void;
  warn(message: string): void;
}

/** One tool a connected server contributed, bound to the server that answers for it. */
export interface McpToolBinding {
  serverId: string;
  serverName: string;
  remoteName: string;
  definition: ToolDefinition;
}

interface Connection {
  client: MCPClient;
  record: McpServerRecord;
  bindings: McpToolBinding[];
}

interface Runtime {
  status: McpServerStatus;
  error?: string;
  stderr: string[];
  connection?: Connection;
  /** In-flight connect, so two turns starting at once share one handshake. */
  connecting?: Promise<void>;
}

/**
 * Every MCP server the user configured, and the tools they contribute to a turn.
 *
 * Three things about this class are load-bearing and should not be traded away:
 *
 *  1. The tools it hands out are ordinary {@link ToolDefinition}s that all declare `approval`.
 *     They go through ChatService's existing gate exactly as `bash_execute` does - there is no
 *     second execution path here, and an MCP server is at least as dangerous as a shell.
 *  2. Nothing a server says about itself is trusted. Names are namespaced and descriptions and
 *     schemas are framed and bounded in names.ts before they reach a prompt.
 *  3. No child outlives the app. `shutdown` is the graceful pass and `shutdownSync` is the one
 *     Electron's `will-quit` can call; both are wired in src/main/index.ts next to the
 *     background-process teardown they copy. The third mechanism background processes have -
 *     an in-child watchdog - has no counterpart here, because the child is someone else's
 *     program and wrapping it in a shell would sit between the app and the JSON-RPC stream.
 */
export class McpManager {
  private readonly runtimes = new Map<string, Runtime>();
  private shuttingDown = false;

  constructor(
    private readonly store: McpServerStore,
    private readonly logger: McpLogger,
    private readonly onChanged: (state: McpServersState) => void
  ) {}

  async state(): Promise<McpServersState> {
    const records = await this.store.list();
    return {
      secretsPersisted: this.store.secretsPersisted(),
      servers: records.map(record => this.describe(record)),
    };
  }

  async addServer(input: McpServerInput): Promise<McpServersState> {
    const record = await this.store.add(input);
    if (record.enabled) void this.connect(record.id);
    return this.publish();
  }

  async updateServer(id: string, input: McpServerInput): Promise<McpServersState> {
    await this.disconnect(id);
    const record = await this.store.update(id, input);
    if (record.enabled) void this.connect(record.id);
    return this.publish();
  }

  async removeServer(id: string): Promise<McpServersState> {
    await this.disconnect(id);
    this.runtimes.delete(id);
    await this.store.remove(id);
    return this.publish();
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServersState> {
    const record = await this.store.setEnabled(id, enabled);
    if (!record) return this.publish();
    if (enabled) void this.connect(id);
    else await this.disconnect(id);
    return this.publish();
  }

  /**
   * Bring every enabled server up, and resolve once they have all settled.
   *
   * Awaited at the top of a turn so the tool list the model is shown is the real one. A server
   * that fails does NOT fail the turn: it is marked failed, the user sees why in the dialog,
   * and the turn proceeds with the tools that did connect.
   */
  async ensureConnected(): Promise<void> {
    if (this.shuttingDown) return;
    const records = await this.store.list();
    await Promise.all(records.filter(record => record.enabled).map(record => this.connect(record.id)));
  }

  /** Every tool currently available, across all connected servers. */
  tools(): McpToolBinding[] {
    return [...this.runtimes.values()].flatMap(runtime => runtime.connection?.bindings ?? []);
  }

  /** Resolve a namespaced tool name. Built-ins are looked up FIRST by the caller; see names.ts. */
  findTool(name: string): ToolDefinition | undefined {
    return this.tools().find(binding => binding.definition.schema.name === name)?.definition;
  }

  /** The server names whose tools are live, for the system message. */
  connectedServerNames(): string[] {
    return [...this.runtimes.values()]
      .filter(runtime => runtime.status === 'connected')
      .map(runtime => runtime.connection?.record.name ?? '')
      .filter(name => name.length > 0);
  }

  async connect(id: string): Promise<void> {
    if (this.shuttingDown) return;
    const existing = this.runtimes.get(id);
    if (existing?.connecting) return existing.connecting;
    if (existing?.status === 'connected') return;

    const record = await this.store.get(id);
    if (!record || !record.enabled) return;

    // A fresh tail per attempt: carrying the last failure's lines forward means a user who
    // clicks Reconnect three times reads the same error three times and cannot tell which
    // attempt it belongs to.
    const runtime: Runtime = { status: 'connecting', stderr: [] };
    this.runtimes.set(id, runtime);
    void this.publish();

    const attempt = this.open(record, runtime)
      .then(connection => {
        runtime.connection = connection;
        runtime.status = 'connected';
        delete runtime.error;
      })
      .catch((err: unknown) => {
        runtime.status = 'failed';
        runtime.error = describeFailure(err, record);
        this.logger.warn(`MCP: "${record.name}" failed to connect: ${runtime.error}`);
      })
      .finally(() => {
        delete runtime.connecting;
        void this.publish();
      });

    runtime.connecting = attempt;
    return attempt;
  }

  async disconnect(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    await runtime.connecting?.catch(() => undefined);

    const connection = runtime.connection;
    delete runtime.connection;
    runtime.status = 'idle';
    delete runtime.error;
    if (!connection) return;

    const pid = connection.client.childPid;
    await connection.client.disconnect().catch(() => undefined);
    // The SDK's close() SIGTERMs the child; a server that ignores that would otherwise survive
    // the app, so the same pid is SIGKILLed a moment later if it is still there.
    if (pid !== null) scheduleKill(pid);
  }

  /** The graceful quit pass: every connection closed, every child asked to stop. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.runtimes.keys()].map(id => this.disconnect(id).catch(() => undefined)));
  }

  /**
   * The pass `will-quit` can call: SIGKILL every stdio child, synchronously and unconditionally.
   *
   * A force-quit that races the grace period above must not leave someone else's node process
   * holding a port. Nothing here awaits, and a pid that is already gone throws ESRCH, which is
   * the success case.
   */
  shutdownSync(): void {
    this.shuttingDown = true;
    for (const runtime of this.runtimes.values()) {
      const pid = runtime.connection?.client.childPid;
      if (pid === null || pid === undefined) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  private async open(record: McpServerRecord, runtime: Runtime): Promise<Connection> {
    const client = new MCPClient({
      name: record.name,
      envVariables: Object.entries(record.env).map(([key, value]) => ({ key, value })),
      ...(record.transport === 'stdio'
        ? { command: record.command, args: record.args }
        : { url: record.url, headers: record.headers }),
      // Piped rather than inherited: a packaged app has no terminal to inherit to, and the
      // child's stderr is the only thing that explains most start-up failures.
      onStderrLine: line => {
        runtime.stderr.push(line);
        if (runtime.stderr.length > STDERR_TAIL_LINES) runtime.stderr.shift();
      },
    });

    try {
      await withTimeout(client.connectToServer(), CONNECT_TIMEOUT_MS, 'The server did not finish starting up.');
    } catch (err) {
      await client.disconnect().catch(() => undefined);
      const pid = client.childPid;
      if (pid !== null) scheduleKill(pid);
      throw err;
    }

    const bindings = this.bind(record, client);
    this.logger.debug(`MCP: "${record.name}" connected with ${bindings.length} tool(s)`);
    return { client, record, bindings };
  }

  /** Turn the server's advertised tools into gated {@link ToolDefinition}s. */
  private bind(record: McpServerRecord, client: MCPClient): McpToolBinding[] {
    const slug = serverSlug(record.name);
    const bindings: McpToolBinding[] = [];
    const taken = new Set<string>();

    for (const tool of client.tools) {
      const name = namespacedToolName(slug, tool.name);
      if (!name) {
        this.logger.warn(`MCP: "${record.name}" declared a tool with an unusable name; skipping it`);
        continue;
      }
      // A server declaring the same tool twice would otherwise give the model two entries it
      // cannot tell apart; the first wins, which is the one its own list put first.
      if (taken.has(name)) continue;
      taken.add(name);

      const schema: ToolSchema = {
        name,
        description: frameDescription(record.name, tool.name, tool.description),
        parameters: sanitizeSchema(tool.input_schema),
      };

      bindings.push({
        serverId: record.id,
        serverName: record.name,
        remoteName: tool.name,
        definition: {
          schema,
          approval: (input): ApprovalPrompt => approvalFor(record, tool.name, input),
          run: (input, context) => this.invoke(record, client, tool.name, input, context),
        },
      });
    }

    return bindings;
  }

  private async invoke(
    record: McpServerRecord,
    client: MCPClient,
    remoteName: string,
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<string> {
    if (context.signal.aborted) throw new Error('The turn was stopped.');

    const result = await withTimeout(
      client.callTool(remoteName, input),
      CALL_TIMEOUT_MS,
      `"${remoteName}" did not answer in time.`
    );

    const text = renderResult(result);
    if (isErrorResult(result)) throw new Error(text);
    return frameResult(record.name, remoteName, text);
  }

  private describe(record: McpServerRecord): McpServerState {
    const runtime = this.runtimes.get(record.id);
    const tools: McpToolSummary[] = (runtime?.connection?.bindings ?? []).map(binding => ({
      name: binding.definition.schema.name,
      remoteName: binding.remoteName,
    }));
    const stderr = (runtime?.stderr ?? []).join('\n');

    return {
      id: record.id,
      name: record.name,
      transport: record.transport,
      enabled: record.enabled,
      status: record.enabled ? (runtime?.status ?? 'idle') : 'disabled',
      ...(record.command ? { command: record.command } : {}),
      ...(record.args.length > 0 ? { args: record.args } : {}),
      ...(record.url ? { url: record.url } : {}),
      envKeys: Object.keys(record.env),
      headerKeys: Object.keys(record.headers),
      tools,
      ...(runtime?.error ? { error: runtime.error } : {}),
      ...(stderr ? { stderr } : {}),
    };
  }

  private async publish(): Promise<McpServersState> {
    const state = await this.state();
    this.onChanged(state);
    return state;
  }
}

/**
 * What the user is asked to allow before an MCP tool runs.
 *
 * The arguments are part of the prompt AND part of the key, so approving one call does not
 * approve a different one through the same tool - the same rule `bash_execute` follows, and it
 * matters more here: the app cannot know what any given MCP tool does, so the arguments are
 * the only thing distinguishing "read issue 4" from "delete the repository".
 */
function approvalFor(record: McpServerRecord, remoteName: string, input: Record<string, unknown>): ApprovalPrompt {
  const args = stableJson(input);
  // The KEY keeps the arguments in full - two calls differing past the cut must not share an
  // approval - while what is DISPLAYED is bounded, so a tool handed a megabyte of text cannot
  // push the buttons off the screen and make "allow" the only thing left to click.
  const shown = args.length > MAX_APPROVAL_ARG_CHARS ? `${args.slice(0, MAX_APPROVAL_ARG_CHARS)}... (truncated)` : args;
  return {
    detail: `Run "${remoteName}" on the MCP server "${record.name}"${args === '{}' ? '' : ` with ${shown}`}`,
    key: `mcp\u0000${record.id}\u0000${remoteName}\u0000${args}`,
  };
}

/** Arguments rendered the same way every time, so the approval key is stable across calls. */
function stableJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, Object.keys(input).sort()) ?? '{}';
  } catch {
    return '{}';
  }
}

interface McpContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

function isErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}

/**
 * The tool result as text for the model.
 *
 * Text blocks are joined as-is; anything else (an image, an embedded resource) is named rather
 * than inlined - the completions path this client uses takes a string tool_result, and a
 * megabyte of base64 in it would be resent on every later turn of a stateless conversation.
 */
function renderResult(result: unknown): string {
  if (typeof result !== 'object' || result === null) return String(result ?? '');

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    return safeJson(structured ?? result);
  }

  const parts = (content as McpContentBlock[]).map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    return `[${typeof block?.type === 'string' ? block.type : 'unknown'} content, which this client cannot show]`;
  });
  const text = parts.join('\n').trim();
  return text.length > 0 ? text : '(the tool returned no content)';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable result]';
  }
}

/**
 * A readable reason a connection failed.
 *
 * ENOENT is the one worth translating: a packaged app inherits the OS launcher's PATH rather
 * than a login shell's, so `npx` resolving by hand and not here is the single most likely
 * first-run failure, and "spawn npx ENOENT" does not say what to do about it.
 */
function describeFailure(err: unknown, record: McpServerRecord): string {
  const message = err instanceof Error ? err.message : String(err);
  if (record.transport === 'stdio' && /ENOENT/.test(message)) {
    return `Could not run "${record.command}". Give the full path to the program if it is not on this app's PATH.`;
  }
  return message;
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** SIGTERM has been sent already; this is the follow-up for a child that ignored it. */
function scheduleKill(pid: number): void {
  const timer = setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is what was wanted.
    }
  }, SIGKILL_DELAY_MS);
  timer.unref?.();
}
