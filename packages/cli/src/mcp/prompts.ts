import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  type GetPromptResult,
  type ListPromptsResult,
  type Prompt,
} from '@modelcontextprotocol/sdk/types.js';
import {
  BRIEFCASE_CATALOG_QUERIES,
  BriefcasePromptIdSchema,
  buildPromptContext,
  replacePromptVariables,
  type IPromptContext,
} from '@bike4mind/common';
import type { B4mApiClient, RawBriefcasePrompt } from './b4mApiClient.js';
import { mapApiError } from './b4mApiClient.js';
import { logger } from '../utils/Logger.js';

type PromptArgumentName = keyof IPromptContext;

/**
 * The `{{placeholder}}` keys a client supplies as prompt arguments. The clock keys
 * (currentDate, currentTime, ...) are not arguments: they are filled at get time,
 * exactly as the web launcher does at click time.
 */
const PROMPT_ARGUMENTS = [
  { name: 'userName', description: 'Your name, substituted for {{userName}}' },
  { name: 'userEmail', description: 'Your email, substituted for {{userEmail}}' },
  { name: 'userRole', description: 'Your role, substituted for {{userRole}}' },
  { name: 'organization', description: 'Your organization, substituted for {{organization}}' },
] as const satisfies ReadonlyArray<{ name: PromptArgumentName; description: string }>;

const PROMPT_ARGUMENT_NAMES = new Set<string>(PROMPT_ARGUMENTS.map(arg => arg.name));

/** Flatten the catalog in category order; a prompt listed under two keys appears once. */
function flattenCatalog(catalog: Record<string, RawBriefcasePrompt[] | undefined>): RawBriefcasePrompt[] {
  const byId = new Map<string, RawBriefcasePrompt>();
  for (const { key } of BRIEFCASE_CATALOG_QUERIES) {
    for (const prompt of catalog[key] ?? []) {
      if (!byId.has(prompt.id)) byId.set(prompt.id, prompt);
    }
  }
  return [...byId.values()];
}

/**
 * List the caller's Briefcase catalog as MCP prompts, named by prompt id (display
 * names are not unique). Degrades to an empty list on failure, like the resource
 * lists: EnableBriefcase is off by default, so a hard error would fail every
 * client's startup listing on most instances.
 */
async function listPrompts(client: B4mApiClient): Promise<ListPromptsResult> {
  try {
    const catalog = await client.getBriefcaseCatalog(BRIEFCASE_CATALOG_QUERIES);
    const prompts: Prompt[] = flattenCatalog(catalog).map(prompt => ({
      name: prompt.id,
      title: prompt.name,
      description: prompt.description,
      arguments: PROMPT_ARGUMENTS.map(arg => ({ ...arg, required: false })),
    }));
    return { prompts };
  } catch (err) {
    logger.error(`mcp: listing briefcase prompts failed: ${mapApiError(err, client.baseURL)}`);
    return { prompts: [] };
  }
}

function toPromptContext(args: Record<string, string> | undefined, now: Date): IPromptContext {
  const supplied = Object.entries(args ?? {}).filter(([name]) => PROMPT_ARGUMENT_NAMES.has(name));
  return { ...buildPromptContext(null, null, now), ...Object.fromEntries(supplied) };
}

/** Resolve one prompt's template against the supplied arguments plus the clock. */
async function getPrompt(
  client: B4mApiClient,
  name: string,
  args: Record<string, string> | undefined,
  now: Date
): Promise<GetPromptResult> {
  const id = BriefcasePromptIdSchema.safeParse(name);
  if (!id.success) throw new McpError(ErrorCode.InvalidParams, `Prompt ${name} not found`);

  let prompt: RawBriefcasePrompt;
  try {
    prompt = await client.getBriefcasePrompt(id.data);
  } catch (err) {
    throw new Error(mapApiError(err, client.baseURL));
  }
  if (!prompt.promptText) throw new Error(`Prompt ${name} has no text`);

  // Unknown placeholders are left in place, matching the web launcher.
  const text = replacePromptVariables(prompt.promptText, toPromptContext(args, now));
  return {
    description: prompt.description ?? prompt.name,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

/**
 * Expose the Briefcase prompt catalog as MCP prompts. Wired on the low-level
 * server rather than through `registerPrompt`: the catalog is per-caller server
 * data that changes at runtime, so it is fetched on every prompts/list instead
 * of being frozen at build time. Requires the `prompts` capability to be declared
 * on the server (see buildMcpServer).
 */
export function registerPrompts(server: McpServer, client: B4mApiClient, now: () => Date = () => new Date()): void {
  server.server.setRequestHandler(ListPromptsRequestSchema, () => listPrompts(client));
  server.server.setRequestHandler(GetPromptRequestSchema, request =>
    getPrompt(client, request.params.name, request.params.arguments, now())
  );
}
