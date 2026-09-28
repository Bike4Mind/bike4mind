import { bashBackground, bashKill, bashList, bashOutput } from './backgroundTools';
import { fileRead, globFiles, grepSearch } from './fileTools';
import { sessionArchive, sessionDelete, sessionList, sessionRead, sessionSpawn } from './hostTools';
import { generateImageTool, generateMusicTool, generateSoundEffectTool, generateSpeechTool } from './mediaTools';
import { bashExecute } from './shellTools';
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
const LOCAL_TOOLS: readonly ToolDefinition[] = [
  fileRead,
  globFiles,
  grepSearch,
  bashExecute,
  fileWrite,
  fileEdit,
  bashBackground,
  bashOutput,
  bashList,
  bashKill,
];

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
 * see hostTools.ts. Reads are ungated; spawning is gated on cost and autonomy, and deleting is
 * gated as irreversible, which no standing approval can cover.
 */
const HOST_TOOLS: readonly ToolDefinition[] = [sessionList, sessionRead, sessionSpawn, sessionArchive, sessionDelete];

const BY_NAME = new Map([...LOCAL_TOOLS, ...MEDIA_TOOLS, ...HOST_TOOLS].map(tool => [tool.schema.name, tool]));

export function findTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * Tool declarations for the request body, in the endpoint's `{ toolSchema }` envelope.
 *
 * The four families are declared independently, because they become available for unrelated
 * reasons. No granted folder means no local tools at all: declaring file tools the model can
 * only be denied teaches it to keep retrying, and an undeclared tool is a cleaner "not
 * available" than one that always fails. The generation tools need only a signed-in session,
 * so they are offered to a user who has shared nothing. The host tools need a project, which
 * is what makes them Code-only. MCP tools are a fourth family, passed in rather than declared
 * here because they only exist once a server the user configured is connected.
 */
export function toolsForRequest(options: {
  roots: readonly string[];
  media: boolean;
  /** A Code session's project binding. Without one the host tools have nothing to scope to. */
  host: boolean;
  /**
   * Schemas contributed by the user's connected MCP servers, already namespaced and framed
   * (see chat/mcp/names.ts). They are appended rather than merged into a family above because
   * a name collision with a built-in must be impossible, not resolved here.
   */
  mcp?: readonly ToolSchema[];
}): { toolSchema: ToolSchema }[] {
  const available = [
    ...(options.roots.length > 0 ? LOCAL_TOOLS : []),
    ...(options.media ? MEDIA_TOOLS : []),
    ...(options.host ? HOST_TOOLS : []),
  ];
  return [
    ...available.map(tool => ({ toolSchema: tool.schema })),
    ...(options.mcp ?? []).map(toolSchema => ({ toolSchema })),
  ];
}
