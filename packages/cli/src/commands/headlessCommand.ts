/**
 * Headless/programmatic mode command (b4m -p "query")
 *
 * Enables non-interactive execution for CI/CD pipelines, scripting, and automation.
 * Runs the agent once with the given prompt and exits with an appropriate exit code.
 */

import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { SessionStore, ConfigStore } from '../storage';
import { CustomCommandStore } from '../storage/CustomCommandStore.js';
import { RemoteSkillSource } from '../storage/RemoteSkillSource.js';
import type { Session } from '../storage';
import { ReActAgent } from '@bike4mind/agents';
import type { AgentStep, AgentResult } from '@bike4mind/agents';
import type { UserQuestionPayload, UserQuestionResponse } from '@bike4mind/services';
import { isReadOnlyTool } from '../config/toolSafety.js';
import { reconstructTurnBlocks } from '../context/ConversationContext.js';
import { buildSystemPrompt } from '../core/prompts';
import { generateCliTools, PermissionManager, type AgentContext, requireApiUrl, loadContextFiles } from '../utils';
import { McpManager } from '../utils/mcpAdapter';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { ServerLlmBackend } from '../llm/ServerLlmBackend';
import { WebSocketLlmBackend } from '../llm/WebSocketLlmBackend';
import { FallbackLlmBackend } from '../llm/FallbackLlmBackend';
import { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';
import { WebSocketToolExecutor } from '../ws/WebSocketToolExecutor';
import { setWebSocketToolExecutor } from '../llm/ToolRouter';
import { ApiClient } from '../auth/ApiClient';
import { logger } from '../utils/Logger';
import { AgentStore } from '../agents/AgentStore.js';
import { SubagentOrchestrator } from '../agents/SubagentOrchestrator.js';
import { BackgroundAgentManager } from '../agents/BackgroundAgentManager.js';
import { createAgentDelegateTool } from '../agents/delegateTool.js';
import { createBackgroundAgentTools } from '../agents/backgroundTools.js';
import { createCoordinateTaskTool } from '../agents/coordinatorTool.js';
import {
  createWriteTodosTool,
  createTodoStore,
  createSkillTool,
  createFindDefinitionTool,
  createGetFileStructureTool,
} from '../tools';
import { CheckpointStore } from '../storage/CheckpointStore.js';
import { createSandboxRuntime } from '../sandbox/runtime/SandboxRuntimeAdapter.js';
import { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';
import { DEFAULT_SANDBOX_CONFIG } from '../sandbox/types.js';
import { ProxyManager } from '../sandbox/proxy/ProxyManager.js';
import { readFile } from 'fs/promises';
import {
  HEADLESS_SCHEMA_VERSION,
  createHeadlessEmitter,
  classifyToolRisk,
  parseStringArray,
  parsePermissionPolicy,
  evaluatePermissionPolicy,
  type HeadlessPermissionPolicy,
} from './headlessProtocol.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface HeadlessOptions {
  prompt: string;
  outputFormat: OutputFormat;
  dangerouslySkipPermissions: boolean;
  verbose: boolean;
  addDirs: string[];
  /** Path to a JSON permission policy for unattended runs (see headlessProtocol.ts). */
  permissionPolicyPath?: string;
}

interface HeadlessJsonResult {
  schemaVersion: string;
  runId: string;
  result: string;
  steps: Array<{
    type: string;
    content: string;
    toolName?: string;
    toolInput?: unknown;
  }>;
  tokenUsage: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
  iterations: number;
  toolCalls: number;
}

/** Read all data from stdin if it's being piped (non-TTY). Returns empty string if no piped data. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', chunk => chunks.push(chunk as Buffer));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);
  });
}

// Silent logger for suppressing internal backend noise
const silentLogger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export async function handleHeadlessCommand(options: HeadlessOptions): Promise<void> {
  const { prompt, outputFormat, dangerouslySkipPermissions, addDirs, permissionPolicyPath } = options;

  logger.setVerbose(options.verbose);

  // Read piped stdin as additional context
  const stdinContent = await readStdin();
  const fullPrompt = stdinContent ? `${prompt}\n\n<stdin>\n${stdinContent}\n</stdin>` : prompt;

  const configStore = new ConfigStore();
  const sessionStore = new SessionStore();
  const customCommandStore = new CustomCommandStore();

  // Stable per-run id stamped on every stream-json event (including a fatal
  // error emitted from the catch below), so consumers can correlate a run.
  const runId = uuidv4();

  try {
    const config = await configStore.load();

    // Load additional directories from all sources. The B4M_ADDITIONAL_DIRS
    // bridge is validated strictly (array of strings) rather than blindly cast.
    const configDirs = await configStore.getAdditionalDirectories();
    const flagDirs = process.env.B4M_ADDITIONAL_DIRS
      ? parseStringArray(process.env.B4M_ADDITIONAL_DIRS, 'B4M_ADDITIONAL_DIRS')
      : [];
    const additionalDirectories = [...new Set([...configDirs, ...flagDirs, ...addDirs])];

    // Load the permission policy for unattended runs, if one was supplied. A
    // read or validation failure throws and is reported via the catch below.
    let permissionPolicy: HeadlessPermissionPolicy | null = null;
    if (permissionPolicyPath) {
      let policyRaw: string;
      try {
        policyRaw = await readFile(permissionPolicyPath, 'utf-8');
      } catch (e) {
        throw new Error(
          `Cannot read permission policy at "${permissionPolicyPath}": ${e instanceof Error ? e.message : String(e)}`
        );
      }
      permissionPolicy = parsePermissionPolicy(policyRaw);
    }

    // Load custom commands (non-critical)
    try {
      await customCommandStore.loadCommands();
    } catch {
      // Ignore failure - custom commands are optional
    }

    // Validate authentication
    const authTokens = await configStore.getAuthTokens();
    if (!authTokens) {
      process.stderr.write('Error: Not authenticated. Run `b4m /login` to authenticate.\n');
      process.exit(1);
    }
    if (new Date(authTokens.expiresAt) <= new Date()) {
      await configStore.clearAuthTokens();
      process.stderr.write('Error: Authentication token expired. Run `b4m /login` to re-authenticate.\n');
      process.exit(1);
    }

    // Initialize LLM backend - WebSocket preferred, SSE fallback.
    // Fail loud when unconfigured rather than handing axios an empty baseURL.
    let apiBaseURL: string;
    try {
      apiBaseURL = requireApiUrl(config.apiConfig);
    } catch (error) {
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    const apiClient = new ApiClient(apiBaseURL, configStore);

    // Layer B4M-web skills on top of the local files already loaded above.
    // Local always wins; remote only fills in unique names. Opt-out via the
    // `--no-remote-skills` CLI flag or `preferences.enableRemoteSkills: false`.
    const remoteSkillsEnabled =
      process.env.B4M_NO_REMOTE_SKILLS !== '1' && config.preferences.enableRemoteSkills !== false;
    if (remoteSkillsEnabled) {
      try {
        customCommandStore.setRemoteSource(new RemoteSkillSource(apiClient));
        await customCommandStore.mergeRemoteCommands();
      } catch {
        // Headless mode prefers silent degradation - a remote fetch failure
        // must not block the user's prompt.
      }
    }

    const tokenGetter = async (): Promise<string | null> => {
      const tokens = await configStore.getAuthTokens();
      return tokens?.accessToken ?? null;
    };

    let wsManager: WebSocketConnectionManager | null = null;
    let llm: ICompletionBackend & { currentModel: string; getModelInfo: () => Promise<{ id: string }[]> };
    let completionsUrl: string | undefined;

    try {
      const serverConfig = await apiClient.get<{
        websocketUrl?: string;
        wsCompletionUrl?: string;
        completionsUrl?: string;
      }>('/api/settings/serverConfig');
      const wsUrl = serverConfig?.websocketUrl;
      const wsCompletionUrl = serverConfig?.wsCompletionUrl;
      completionsUrl = serverConfig?.completionsUrl;

      if (wsUrl && wsCompletionUrl) {
        wsManager = new WebSocketConnectionManager(wsUrl, tokenGetter, () => apiClient.checkSessionValid());
        wsManager.onRevoked(() => {
          logger.warn('[headless] Session revoked - run `b4m login` again. WebSocket reconnect stopped.');
        });
        await wsManager.connect();
        const wsToolExecutor = new WebSocketToolExecutor(wsManager, tokenGetter);
        setWebSocketToolExecutor(wsToolExecutor);
        llm = new WebSocketLlmBackend({
          wsManager,
          apiClient,
          model: config.defaultModel,
          tokenGetter,
          wsCompletionUrl,
        });
        logger.debug('[headless] Using WebSocket transport');
      } else {
        throw new Error('No websocketUrl or wsCompletionUrl in server config');
      }
    } catch {
      // A failed connect() still schedules a verify/reconnect via onclose. Falling back to
      // SSE without tearing that down would leave an orphaned reconnect loop running with
      // no owner, so disconnect before dropping the reference.
      wsManager?.disconnect();
      wsManager = null;
      setWebSocketToolExecutor(null);
      llm = new ServerLlmBackend({ apiClient, model: config.defaultModel, completionsUrl });
      logger.debug('[headless] Using SSE transport fallback');
    }

    // Resolve model
    const models = await llm.getModelInfo();
    if (models.length === 0) {
      throw new Error('No models available from server.');
    }
    const modelInfo = models.find(m => m.id === config.defaultModel) ?? models[0];
    llm.currentModel = modelInfo.id;

    // Wrap with FallbackLlmBackend when fallback models are configured
    const effectiveLlm: ICompletionBackend =
      config.fallbackModels && config.fallbackModels.length > 0
        ? new FallbackLlmBackend(llm, config.fallbackModels, (fromModel, toModel, error) => {
            process.stderr.write(
              `⚠️  Model "${fromModel}" failed (${error.message}). Falling back to "${toModel}"...\n`
            );
          })
        : llm;

    // Create session
    const session: Session = {
      id: uuidv4(),
      name: `Headless ${new Date().toISOString()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: modelInfo.id,
      messages: [],
      metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
    };

    await logger.initialize(session.id);

    // Initialize permission manager
    const permissionManager = new PermissionManager(config.trustedTools ?? [], undefined, config.tools.disabled);

    // NDJSON emitter, stamped with schemaVersion + runId (see headlessProtocol.ts).
    // Shared by the permission protocol below and the step stream further down.
    const emit = createHeadlessEmitter(runId, line => process.stdout.write(line));
    const streaming = outputFormat === 'stream-json';

    // Permission prompt function for headless mode. Every gated tool surfaces a
    // structured permission_request + permission_decision pair on the stream (so
    // decisions are never silent), then resolves the decision. Precedence:
    //   --dangerously-skip-permissions -> allow-once (explicit blanket override);
    //   a --permission-policy -> its per-tool/per-risk verdict;
    //   otherwise -> deny (safe default, no silent auto-approve).
    const promptFn = (
      toolName: string,
      args: unknown,
      _preview?: string
    ): Promise<{ action: 'allow-once' | 'allow-session' | 'allow-always' | 'deny' }> => {
      const risk = classifyToolRisk(toolName, args, permissionManager.getCategory(toolName));
      if (streaming) {
        emit({ type: 'permission_request', toolName, risk });
      }

      let decision: { action: 'allow-once' | 'deny'; reason: string };
      if (dangerouslySkipPermissions) {
        decision = { action: 'allow-once', reason: 'dangerously-skip-permissions' };
      } else if (permissionPolicy) {
        const verdict = evaluatePermissionPolicy(permissionPolicy, toolName, risk.level);
        decision = { action: verdict.action === 'allow' ? 'allow-once' : 'deny', reason: verdict.reason };
      } else {
        decision = { action: 'deny', reason: 'no permission policy; default deny' };
      }

      if (streaming) {
        emit({
          type: 'permission_decision',
          toolName,
          action: decision.action,
          reason: decision.reason,
          risk: risk.level,
        });
      } else if (decision.action === 'deny') {
        process.stderr.write(
          `Warning: Tool "${toolName}" requires permission and was denied (${decision.reason}). ` +
            `Grant it via --permission-policy, or --dangerously-skip-permissions to allow all tools.\n`
        );
      }

      if (decision.action === 'allow-once') {
        logger.debug(`[headless] Auto-allowing tool: ${toolName}`);
      }
      return Promise.resolve({ action: decision.action });
    };

    // User question function - headless mode cannot respond interactively
    const userQuestionFn = (_payload: UserQuestionPayload): Promise<UserQuestionResponse> => {
      process.stderr.write(
        'Warning: Agent requested user input; headless mode cannot respond interactively. Answering with empty response.\n'
      );
      return Promise.resolve({ answers: [] });
    };

    // Initialize sandbox and checkpoint store in parallel (independent)
    const sandboxConfig = config.sandbox ?? DEFAULT_SANDBOX_CONFIG;
    const checkpointProjectDir = configStore.getProjectConfigDir() ?? process.cwd();
    const checkpointStore = new CheckpointStore(checkpointProjectDir);

    const [sandboxRuntime] = await Promise.all([
      createSandboxRuntime(),
      checkpointStore.init(session.id).catch(() => {}),
    ]);

    const proxyManager = new ProxyManager(sandboxConfig.network);
    const sandboxOrchestrator = new SandboxOrchestrator(sandboxConfig, sandboxRuntime, proxyManager);
    permissionManager.setSandboxState(sandboxConfig.mode, sandboxOrchestrator.isActive());

    // Agent context for observation tracking
    const agentContext: AgentContext = {
      currentAgent: null,
      observationQueue: [],
    };

    // Generate tools
    const { tools: b4mTools } = await generateCliTools(
      config.userId,
      llm,
      modelInfo.id,
      permissionManager,
      promptFn,
      agentContext,
      configStore,
      apiClient,
      undefined,
      userQuestionFn,
      checkpointStore,
      sandboxOrchestrator,
      additionalDirectories
    );

    // Initialize MCP, agent store, and context files in parallel (all independent)
    const mcpManager = new McpManager(config);
    const projectConfigDir = configStore.getProjectConfigDir();
    const builtinAgentsDir = new URL('../agents/defaults/', import.meta.url).pathname;
    const agentStore = new AgentStore(builtinAgentsDir, projectConfigDir ?? process.cwd());

    const [, , contextResult] = await Promise.all([
      mcpManager.initialize(),
      agentStore.loadAgents(),
      loadContextFiles(projectConfigDir),
    ]);

    const mcpTools = mcpManager.getTools();

    // Initialize subagent orchestrator
    const orchestrator = new SubagentOrchestrator({
      userId: config.userId,
      llm,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: silentLogger as any, // silentLogger satisfies Logger structurally but lacks full type metadata
      permissionManager,
      showPermissionPrompt: promptFn,
      configStore,
      apiClient,
      agentStore,
      customCommandStore,
      enableParallelToolExecution: config.preferences.enableParallelToolExecution === true,
      showUserQuestion: userQuestionFn,
      checkpointStore,
    });

    const backgroundManager = new BackgroundAgentManager(orchestrator);
    const agentDelegateTool = createAgentDelegateTool(orchestrator, agentStore, session.id, backgroundManager);
    const backgroundTools = createBackgroundAgentTools(backgroundManager);
    const todoStore = createTodoStore();
    const writeTodosTool = createWriteTodosTool(todoStore);
    const findDefinitionTool = createFindDefinitionTool();
    const getFileStructureTool = createGetFileStructureTool();

    const enableSkillTool = config.preferences.enableSkillTool !== false;
    const skillTool = enableSkillTool
      ? createSkillTool({ customCommandStore, subagentOrchestrator: orchestrator, sessionId: session.id })
      : null;

    const cliTools = [agentDelegateTool, ...backgroundTools, writeTodosTool, findDefinitionTool, getFileStructureTool];
    if (skillTool) cliTools.push(skillTool);

    // Add coordinate_task tool (gated by config flag)
    if (config.preferences.enableCoordinatorMode === true) {
      const coordinateTaskTool = createCoordinateTaskTool(orchestrator, agentStore, session.id);
      cliTools.push(coordinateTaskTool);
    }

    const allTools = [...b4mTools, ...mcpTools, ...cliTools];

    // Build system prompt - variant comes from config preference
    const systemPrompt = buildSystemPrompt(config.preferences.promptVariant ?? 'current', {
      contextContent: contextResult.mergedContent,
      agentStore,
      customCommands: customCommandStore.getAllCommands(),
      enableSkillTool,
      enableDynamicAgentCreation: false,
      additionalDirectories,
    });

    const maxIterations = config.preferences.maxIterations === null ? 999999 : config.preferences.maxIterations;

    // Create agent
    const agent = new ReActAgent({
      userId: config.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: silentLogger as any, // silentLogger satisfies Logger structurally but lacks full type metadata
      llm: effectiveLlm,
      model: modelInfo.id,
      tools: allTools,
      maxIterations,
      maxTokens: config.preferences.maxTokens,
      temperature: config.preferences.temperature,
      systemPrompt,
    });

    agentContext.currentAgent = agent;

    (agent as unknown as Record<string, unknown>).observationQueue = agentContext.observationQueue;

    // Set up step streaming for stream-json format (emitter created above).
    if (streaming) {
      agent.on('thought', (step: AgentStep) => {
        emit({ type: 'thought', content: step.content });
      });

      agent.on('action', (step: AgentStep) => {
        emit({
          type: 'action',
          content: step.content,
          toolName: step.metadata?.toolName,
          toolInput: step.metadata?.toolInput,
        });
      });

      agent.on('observation', (step: AgentStep) => {
        emit({ type: 'observation', content: step.content, toolName: step.metadata?.toolName });
      });
    }

    // Run the agent
    const turnId = `turn-${randomBytes(4).toString('hex')}`;
    backgroundManager.setCurrentTurn(turnId);

    let result: AgentResult;
    try {
      result = await agent.run(fullPrompt, {
        parallelExecution: config.preferences.enableParallelToolExecution === true,
        isReadOnlyTool,
        maxHistoryIterations: 4,
      });
    } finally {
      backgroundManager.setCurrentTurn(null);
    }

    // Save minimal session record. The assistant message keeps its lossless tool
    // trace on richContent so a later `--resume` of this session replays tool
    // results, not just the final prose (same rule as the interactive paths).
    const richContent = reconstructTurnBlocks(result.steps, result.finalAnswer);
    const finalSession: Session = {
      ...session,
      messages: [
        { id: uuidv4(), role: 'user', content: fullPrompt, timestamp: new Date().toISOString() },
        {
          id: uuidv4(),
          role: 'assistant',
          content: result.finalAnswer,
          ...(richContent ? { richContent } : {}),
          timestamp: new Date().toISOString(),
        },
      ],
      updatedAt: new Date().toISOString(),
      metadata: {
        totalTokens: result.completionInfo.totalTokens,
        totalCost: 0,
        toolCallCount: result.completionInfo.toolCalls,
      },
    };
    await sessionStore.save(finalSession);

    // Output in the requested format
    switch (outputFormat) {
      case 'text':
        process.stdout.write(result.finalAnswer + '\n');
        break;

      case 'json': {
        const jsonResult: HeadlessJsonResult = {
          schemaVersion: HEADLESS_SCHEMA_VERSION,
          runId,
          result: result.finalAnswer,
          steps: result.steps.map(s => ({
            type: s.type,
            content: s.content,
            toolName: s.metadata?.toolName,
            toolInput: s.metadata?.toolInput,
          })),
          tokenUsage: {
            totalTokens: result.completionInfo.totalTokens,
            inputTokens: result.completionInfo.totalInputTokens,
            outputTokens: result.completionInfo.totalOutputTokens,
          },
          iterations: result.completionInfo.iterations,
          toolCalls: result.completionInfo.toolCalls,
        };
        process.stdout.write(JSON.stringify(jsonResult, null, 2) + '\n');
        break;
      }

      case 'stream-json':
        // Emit final result line (steps already emitted in real-time above)
        emit({
          type: 'result',
          content: result.finalAnswer,
          tokenUsage: {
            totalTokens: result.completionInfo.totalTokens,
            inputTokens: result.completionInfo.totalInputTokens,
            outputTokens: result.completionInfo.totalOutputTokens,
          },
          iterations: result.completionInfo.iterations,
          toolCalls: result.completionInfo.toolCalls,
        });
        break;
    }

    // Cleanup
    await mcpManager.disconnect().catch(() => {});
    if (wsManager) wsManager.disconnect();
    setWebSocketToolExecutor(null);
    agent.removeAllListeners();

    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify({ schemaVersion: HEADLESS_SCHEMA_VERSION, runId, error: message }) + '\n');
    } else if (outputFormat === 'stream-json') {
      createHeadlessEmitter(runId, line => process.stdout.write(line))({ type: 'error', error: message });
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }

    process.exit(1);
  }
}
