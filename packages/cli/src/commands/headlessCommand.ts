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
import { buildSystemPrompt } from '../core/prompts';
import { generateCliTools, PermissionManager, type AgentContext, getApiUrl, loadContextFiles } from '../utils';
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

export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface HeadlessOptions {
  prompt: string;
  outputFormat: OutputFormat;
  dangerouslySkipPermissions: boolean;
  verbose: boolean;
  addDirs: string[];
}

interface HeadlessJsonResult {
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
  const { prompt, outputFormat, dangerouslySkipPermissions, addDirs } = options;

  logger.setVerbose(options.verbose);

  // Read piped stdin as additional context
  const stdinContent = await readStdin();
  const fullPrompt = stdinContent ? `${prompt}\n\n<stdin>\n${stdinContent}\n</stdin>` : prompt;

  const configStore = new ConfigStore();
  const sessionStore = new SessionStore();
  const customCommandStore = new CustomCommandStore();

  try {
    const config = await configStore.load();

    // Load additional directories from all sources
    const configDirs = await configStore.getAdditionalDirectories();
    const flagDirs = process.env.B4M_ADDITIONAL_DIRS ? (JSON.parse(process.env.B4M_ADDITIONAL_DIRS) as string[]) : [];
    const additionalDirectories = [...new Set([...configDirs, ...flagDirs, ...addDirs])];

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

    // Initialize LLM backend - WebSocket preferred, SSE fallback
    const apiBaseURL = getApiUrl(config.apiConfig);
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
        wsManager = new WebSocketConnectionManager(wsUrl, tokenGetter);
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

    // Permission prompt function for headless mode.
    // With --dangerously-skip-permissions: auto-allow-once.
    // Without: auto-deny and print a warning to stderr.
    const promptFn = (
      toolName: string,
      _args: unknown,
      _preview?: string
    ): Promise<{ action: 'allow-once' | 'allow-session' | 'allow-always' | 'deny' }> => {
      if (dangerouslySkipPermissions) {
        logger.debug(`[headless] Auto-allowing tool: ${toolName}`);
        return Promise.resolve({ action: 'allow-once' });
      }
      process.stderr.write(
        `Warning: Tool "${toolName}" requires permission and was denied. Use --dangerously-skip-permissions to auto-allow tools in headless mode.\n`
      );
      return Promise.resolve({ action: 'deny' });
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

    // Set up step streaming for stream-json format
    if (outputFormat === 'stream-json') {
      const emitNdjson = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n');

      agent.on('thought', (step: AgentStep) => {
        emitNdjson({ type: 'thought', content: step.content });
      });

      agent.on('action', (step: AgentStep) => {
        emitNdjson({
          type: 'action',
          content: step.content,
          toolName: step.metadata?.toolName,
          toolInput: step.metadata?.toolInput,
        });
      });

      agent.on('observation', (step: AgentStep) => {
        emitNdjson({ type: 'observation', content: step.content, toolName: step.metadata?.toolName });
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

    // Save minimal session record
    const finalSession: Session = {
      ...session,
      messages: [
        { id: uuidv4(), role: 'user', content: fullPrompt, timestamp: new Date().toISOString() },
        { id: uuidv4(), role: 'assistant', content: result.finalAnswer, timestamp: new Date().toISOString() },
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
        process.stdout.write(
          JSON.stringify({
            type: 'result',
            content: result.finalAnswer,
            tokenUsage: {
              totalTokens: result.completionInfo.totalTokens,
              inputTokens: result.completionInfo.totalInputTokens,
              outputTokens: result.completionInfo.totalOutputTokens,
            },
            iterations: result.completionInfo.iterations,
            toolCalls: result.completionInfo.toolCalls,
          }) + '\n'
        );
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
      process.stdout.write(JSON.stringify({ error: message }) + '\n');
    } else if (outputFormat === 'stream-json') {
      process.stdout.write(JSON.stringify({ type: 'error', error: message }) + '\n');
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }

    process.exit(1);
  }
}
