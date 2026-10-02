import { askUser } from './askUserTool';
import { applyPatch, usesApplyPatch } from './applyPatchTool';
import { bashBackground, bashKill, bashList, bashOutput } from './backgroundTools';
import { BROWSER_TOOLS } from './browserTools';
import { exploreTool } from './exploreTool';
import { fileRead, globFiles, grepSearch } from './fileTools';
import { sessionArchive, sessionDelete, sessionList, sessionRead, sessionSend, sessionSpawn } from './hostTools';
import { generateImageTool, generateMusicTool, generateSoundEffectTool, generateSpeechTool } from './mediaTools';
import { memoryDelete, memoryRead, memoryWrite } from './memoryTools';
import { bashExecute } from './shellTools';
import { skillTool } from './skillTool';
import { todoWrite } from './todoTool';
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
  todoWrite,
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
 * see hostTools.ts. Reads are ungated; spawning and messaging are gated on cost and autonomy,
 * and deleting is gated as irreversible, which no standing approval can cover.
 */
const HOST_TOOLS: readonly ToolDefinition[] = [
  sessionList,
  sessionRead,
  sessionSpawn,
  sessionSend,
  sessionArchive,
  sessionDelete,
];

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
    applyPatch,
    exploreTool,
    ...MEDIA_TOOLS,
    ...HOST_TOOLS,
    ...BROWSER_TOOLS,
    ...MEMORY_TOOLS,
    ...SKILL_TOOLS,
    askUser,
  ].map(tool => [tool.schema.name, tool])
);

export function findTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
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
 * Two families need neither a folder nor a project nor a sign-in. The skill tool reads the
 * user's own skill files, so it is offered wherever a catalog exists. The browser tools drive
 * a page keyed on the conversation id and nothing else: they are offered in every conversation
 * that has a browser to drive, Chat sessions and projectless Code sessions included. They were
 * once gated with the host tools, which was never a precondition of theirs - browsing needs
 * nothing from a folder.
 */
export function toolsForRequest(options: {
  roots: readonly string[];
  media: boolean;
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
  /** A resolved memory store. Needs a project, which is what the store is keyed on. */
  memory?: boolean;
  /** A skill catalog for this session. No folder grant needed; a global skill is the user's own file. */
  skills?: boolean;
  /** A user is present to answer: main conversations, not spawned sessions. */
  ask?: boolean;
  /**
   * Schemas contributed by the user's connected MCP servers, already namespaced and framed
   * (see chat/mcp/names.ts). They are appended rather than merged into a family above because
   * a name collision with a built-in must be impossible, not resolved here.
   */
  mcp?: readonly ToolSchema[];
}): { toolSchema: ToolSchema }[] {
  const available = [
    ...(options.roots.length > 0 ? localTools(usesApplyPatch(options.modelId)) : []),
    ...(options.roots.length > 0 && options.explore ? [exploreTool] : []),
    ...(options.media ? MEDIA_TOOLS : []),
    ...(options.host ? HOST_TOOLS : []),
    ...(options.browser ? BROWSER_TOOLS : []),
    ...(options.memory ? MEMORY_TOOLS : []),
    ...(options.skills ? SKILL_TOOLS : []),
    ...(options.ask ? [askUser] : []),
  ];
  return [
    ...available.map(tool => ({ toolSchema: tool.schema })),
    ...(options.mcp ?? []).map(toolSchema => ({ toolSchema })),
  ];
}
