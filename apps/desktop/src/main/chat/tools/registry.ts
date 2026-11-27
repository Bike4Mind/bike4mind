import { askUser } from './askUserTool';
import { applyPatch, usesApplyPatch } from './applyPatchTool';
import { bashBackground, bashKill, bashList, bashOutput } from './backgroundTools';
import { BROWSER_TOOLS } from './browserTools';
import { exploreTool } from './exploreTool';
import { fileRead, globFiles, grepSearch } from './fileTools';
import {
  sessionArchive,
  sessionDelete,
  sessionRename,
  sessionList,
  sessionRead,
  sessionSend,
  delegatedSpawnSchema,
  questComplete,
  taskReport,
  taskAssess,
  sessionSpawn,
  sessionSuggestionDismiss,
  sessionSuggestionUpdate,
} from './hostTools';
import type { VideoModel } from '@bike4mind/common';
import {
  generateImageTool,
  generateMusicTool,
  generateSoundEffectTool,
  generateSpeechTool,
  generateVideoSchema,
  generateVideoTool,
  saveGeneratedImageTool,
} from './mediaTools';
import { MCP_READ_TOOLS, MCP_TOOLS } from './mcpTools';
import { loopTool } from './loopTool';
import { memoryDelete, memoryRead, memoryWrite } from './memoryTools';
import { setSessionPullRequest } from './pullRequestTool';
import { requestDirectory } from './requestDirectoryTool';
import { screenCapture } from './screenTools';
import { bashExecute } from './shellTools';
import { MODEL_TOOLS } from './modelTools';
import { SIMULATOR_TOOLS } from './simulatorTools';
import { skillTool } from './skillTool';
import { todoWrite } from './todoTool';
import { WEB_TOOLS } from './webTools';
import { fileEdit, fileWrite } from './writeTools';
import type { ToolDefinition, ToolSchema } from './types';

/**
 * The tools that act on this machine.
 *
 * Reads run unattended; `bash_execute` runs code and the write tools change files, so each
 * declares `approval` and ChatService holds it at the gate until the user answers. A write
 * additionally shows the user the diff it would apply before they answer.
 *
 * `bash_background` runs code too and is gated the same way. The three tools around it -
 * `bash_output`, `bash_list`, `bash_kill` - only inspect or stop processes the user has
 * already approved, so they are not gated: a second dialog to stop a dev server would just
 * make the safe action the slow one.
 */
const localTools = (patch: boolean): readonly ToolDefinition[] => [
  fileRead,
  globFiles,
  grepSearch,
  bashExecute,
  ...(patch ? [applyPatch] : [fileWrite, fileEdit]),
  bashBackground,
  bashOutput,
  bashList,
  bashKill,
];

/**
 * GPT models are trained on the apply_patch format and get it in place of file_edit and
 * file_write; every other model keeps those two. ChatService also refuses the family a model
 * was not offered, so a stale name from an earlier turn on another model cannot run.
 */
export { usesApplyPatch };

export function isOfferedEditTool(name: string, patch: boolean): boolean {
  if (name === 'apply_patch') return patch;
  if (name === 'file_edit' || name === 'file_write') return !patch;
  return true;
}

/**
 * The tools that call the Bike4Mind server: image generation and the three Audio-tag
 * operations.
 *
 * Their availability has nothing to do with the folder grant - they touch no files the user
 * owns - so they are offered whenever there is a signed-in session to spend against. Every one
 * of them is gated, for cost rather than safety; see mediaTools.ts.
 */
const MEDIA_TOOLS: readonly ToolDefinition[] = [
  generateImageTool,
  generateSpeechTool,
  generateSoundEffectTool,
  generateMusicTool,
];

/**
 * The tools that drive this app: starting, listing, reading and removing conversations.
 *
 * Code sessions only, because every one of them is scoped to the calling session's project -
 * see hostTools.ts. Reads and session_rename are ungated; spawning and messaging are gated on
 * cost and autonomy, and deleting is gated as irreversible, which no standing approval can cover.
 */
const SHARED_HOST_TOOLS: readonly ToolDefinition[] = [
  sessionList,
  sessionRead,
  sessionSend,
  sessionArchive,
  sessionRename,
  sessionDelete,
];

const HOST_TOOLS: readonly ToolDefinition[] = [...SHARED_HOST_TOOLS, sessionSpawn];

const MCP_MANAGE_TOOLS = MCP_TOOLS.filter(tool => !MCP_READ_TOOLS.includes(tool));

/** Revising a spawn suggestion, which only exists where a user is present to see its card. */
const SUGGESTION_TOOLS: readonly ToolDefinition[] = [sessionSuggestionUpdate, sessionSuggestionDismiss];

/**
 * The project's long-term memory: recall what was recorded before, and record something new.
 *
 * A family of its own because its risk is neither the filesystem's nor the server's. The store
 * sits outside every folder the user shared - see memoryTools.ts for why it has to - so reading
 * is ungated like every other read here, and writing and deleting are gated exactly as the file
 * tools are, with the bytes shown: the user is allowing a change somewhere they never granted.
 */
const MEMORY_TOOLS: readonly ToolDefinition[] = [memoryRead, memoryWrite, memoryDelete];

/**
 * Running one of the user's own skills, the way typing `/name` in the composer does.
 *
 * A family of one, offered whenever there is a catalog to read - including in a conversation
 * that has been granted no folder, because a global skill is a file of the user's instructions
 * and does not need one. It is the only family here that is neither gated nor needs to be: the
 * call reads a markdown file and returns its text, and everything the returned instructions then
 * ask for is an ordinary tool call that stops at the gate. See skillTool.ts.
 *
 * What it may list and run is decided by the SESSION, not by its arguments: a project's skills
 * are withheld until the user trusts that project, which is the same gate the composer's picker
 * passes, and a skill marked not-model-invocable is absent from both the prompt list and this
 * tool's reach.
 */
const SKILL_TOOLS: readonly ToolDefinition[] = [skillTool];

const BY_NAME = new Map(
  [
    ...localTools(false),
    todoWrite,
    applyPatch,
    exploreTool,
    ...MEDIA_TOOLS,
    generateVideoTool,
    saveGeneratedImageTool,
    ...HOST_TOOLS,
    ...SUGGESTION_TOOLS,
    questComplete,
    taskReport,
    taskAssess,
    ...BROWSER_TOOLS,
    screenCapture,
    ...SIMULATOR_TOOLS,
    ...MODEL_TOOLS,
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    askUser,
    requestDirectory,
    loopTool,
    setSessionPullRequest,
    ...MCP_TOOLS,
    ...WEB_TOOLS,
  ].map(tool => [tool.schema.name, tool])
);

export function findTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * The generation tool names toolsForRequest declares for the same `media` and `video` inputs, for
 * the blank chat's suggestions. Read off the same constants so the two cannot disagree.
 */
export function offeredMediaToolNames(options: { media: boolean; video?: readonly VideoModel[] }): string[] {
  if (!options.media) return [];
  return [
    ...MEDIA_TOOLS.map(tool => tool.schema.name),
    ...(options.video?.length ? [generateVideoTool.schema.name] : []),
  ];
}

/**
 * session_spawn for a managed worker: the delegated parameters without `isolation`, which only a
 * session with delegates reads; a managed worker's spawn is placed by cardPlacement (hostTools.ts).
 */
function managedSpawnSchema(modelHint: string | null): ToolSchema {
  const { parameters } = delegatedSpawnSchema(modelHint);
  const properties = Object.fromEntries(Object.entries(parameters.properties).filter(([key]) => key !== 'isolation'));
  return { ...sessionSpawn.schema, parameters: { ...parameters, properties } };
}

/**
 * Tool declarations for the request body, in the endpoint's `{ toolSchema }` envelope.
 *
 * Every family is declared independently, because each becomes available for its own unrelated
 * reason. No granted folder means no local tools at all: declaring file tools the model can
 * only be denied teaches it to keep retrying, and an undeclared tool is a cleaner "not
 * available" than one that always fails. The generation tools need only a signed-in session,
 * so they are offered to a user who has shared nothing. The host tools need a project, which
 * is what makes them Code-only. MCP tools are passed in rather than declared here because they
 * only exist once a server the user configured is connected.
 *
 * todo_write is declared in every conversation: the plan is the call's own input and lives in
 * the transcript (see todoTool.ts), so it touches nothing and needs nothing granted.
 *
 * Two families need neither a folder nor a project nor a sign-in. The skill tool reads the
 * user's own skill files, so it is offered wherever a catalog exists. The browser tools drive
 * a page keyed on the conversation id and nothing else: they are offered in every conversation
 * that has a browser to drive, Chat sessions and projectless Code sessions included. They were
 * once gated with the host tools, which was never a precondition of theirs - browsing needs
 * nothing from a folder.
 */
export function toolsForRequest(options: {
  /**
   * A Studio session: the generation tools and nothing else, whatever the other flags say. No
   * shell, file, browser, host or MCP tool, because a Studio conversation runs nothing locally.
   */
  studio?: boolean;
  roots: readonly string[];
  media: boolean;
  /**
   * The video models the server offers this caller. generate_video is declared only when there
   * is at least one, with them in its schema, so a server without video has no tool to fail.
   */
  video?: readonly VideoModel[];
  /** A Code session's project binding. Without one the host tools have nothing to scope to. */
  host: boolean;
  /**
   * A transport for the `explore` sub-agent. Offered only beside the local tools, since the
   * files it would read are exactly the ones they can.
   */
  explore?: boolean;
  /** The session's model id; decides between apply_patch and file_edit/file_write. */
  modelId?: string;
  /** A hidden browser for this session. Every conversation gets one; it needs no project. */
  browser?: boolean;
  /**
   * The app can see other apps' windows. Like the browser it needs no folder or project: it reads
   * the user's screen, which is gated per capture rather than by a grant.
   */
  screen?: boolean;
  /**
   * The iOS Simulator, on macOS only. Needs no folder or project to drive a device; building one
   * resolves its project inside the granted roots and refuses without one.
   */
  simulator?: boolean;
  /**
   * The 3D model pane. Code sessions with a working directory only: a model and the GLB written
   * beside it live in the project.
   */
  model?: boolean;
  /** A resolved memory store. Needs a project, which is what the store is keyed on. */
  memory?: boolean;
  /** A skill catalog for this session. No folder grant needed; a global skill is the user's own file. */
  skills?: boolean;
  /**
   * A signed-in session to search and fetch through. Needs nothing else: like the generation
   * tools, the work happens on the server and touches no file the user owns.
   */
  web?: boolean;
  /**
   * A user is present to answer a card: every turn of a main conversation, and a turn the user
   * typed into a spawned one.
   */
  ask?: boolean;
  /**
   * The host keeps a suggestion tray for this conversation, which a spawned session never has even
   * when the user is typing in it. Defaults to `ask`.
   */
  suggestions?: boolean;
  /** Orchestrate is in effect, so session_spawn starts rather than suggests; see HostContext.delegates. */
  delegates?: boolean;
  structuredTask?: boolean;
  managedDelegation?: boolean;
  /** What a delegated session_spawn may name in requested_model_id; see modelRequestHint. */
  spawnModelHint?: string | null;
  /**
   * Schemas contributed by the user's connected MCP servers, already namespaced and framed
   * (see chat/mcp/names.ts). They are appended rather than merged into a family above because
   * a name collision with a built-in must be impossible, not resolved here.
   */
  mcp?: readonly ToolSchema[];
  /**
   * The app has an MCP manager. Offers mcp_list_servers, and with a user present the tools that
   * add and change servers, whose cards only that user can answer. Static schemas, declared
   * whether or not anything is configured, so the tool list does not churn as servers come and go.
   */
  mcpServers?: boolean;
  /**
   * A Code session with a PR monitor. Offers set_session_pull_request, which only a turn the user
   * typed may run.
   */
  pullRequest?: boolean;
}): { toolSchema: ToolSchema }[] {
  if (options.studio) return studioTools(options);
  // Shared families first and per-session ones last, so a spawned worker's list is a prefix of
  // its parent's and sibling workers share one cached prefix; see ChatService.promptPrefix.test.ts.
  const available = [
    ...(options.roots.length > 0 ? localTools(usesApplyPatch(options.modelId)) : []),
    todoWrite,
    ...(options.roots.length > 0 && options.explore ? [exploreTool] : []),
    ...(options.media ? MEDIA_TOOLS : []),
    // Writes into the project, so it needs a granted folder as well as a session that generated something.
    ...(options.media && options.roots.length > 0 ? [saveGeneratedImageTool] : []),
    ...(options.browser ? BROWSER_TOOLS : []),
    ...(options.screen ? [screenCapture] : []),
    ...(options.simulator ? SIMULATOR_TOOLS : []),
    ...(options.model && options.roots.length > 0 ? MODEL_TOOLS : []),
    ...(options.memory ? MEMORY_TOOLS : []),
    ...(options.skills ? SKILL_TOOLS : []),
    ...(options.web ? WEB_TOOLS : []),
    ...(options.mcpServers ? MCP_READ_TOOLS : []),
    ...(options.host ? SHARED_HOST_TOOLS : []),
  ];
  const sessionSpecific = [
    ...(options.host && (options.delegates || options.managedDelegation) ? [taskAssess] : []),
    // Its schema depends on the session's delegation; see the mapping below.
    ...(options.host ? [sessionSpawn] : []),
    ...(options.host && (options.suggestions ?? options.ask) ? SUGGESTION_TOOLS : []),
    ...(options.host && options.delegates ? [questComplete] : []),
    ...(options.host && options.structuredTask ? [taskReport] : []),
    // Offered with no folder granted too: asking for one is exactly what that conversation needs.
    ...(options.ask ? [askUser, requestDirectory, loopTool] : []),
    // Declared on every turn of such a session, unattended ones included, so a wake keeps the
    // tool list; its run refuses when nobody typed the turn (see pullRequestTool.ts).
    ...(options.pullRequest ? [setSessionPullRequest] : []),
    ...(options.mcpServers && options.ask ? MCP_MANAGE_TOOLS : []),
  ];
  const schemaOf = (tool: ToolDefinition): ToolSchema =>
    tool === sessionSpawn && options.delegates
      ? delegatedSpawnSchema(options.spawnModelHint ?? null)
      : tool === sessionSpawn && options.managedDelegation
        ? managedSpawnSchema(options.spawnModelHint ?? null)
        : tool.schema;
  return [
    ...available.map(tool => ({ toolSchema: schemaOf(tool) })),
    ...(options.media && options.video?.length ? [{ toolSchema: generateVideoSchema(options.video) }] : []),
    ...(options.mcp ?? []).map(toolSchema => ({ toolSchema })),
    ...sessionSpecific.map(tool => ({ toolSchema: schemaOf(tool) })),
  ];
}

function studioTools(options: { media: boolean; video?: readonly VideoModel[] }): { toolSchema: ToolSchema }[] {
  if (!options.media) return [];
  return [
    ...MEDIA_TOOLS.map(tool => ({ toolSchema: tool.schema })),
    ...(options.video?.length ? [{ toolSchema: generateVideoSchema(options.video) }] : []),
  ];
}
