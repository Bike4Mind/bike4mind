/**
 * SRE Diagnostician tool definitions and executor.
 *
 * GitHub-backed tools for the Diagnostician LLM tool-use loop.
 * Tool schemas and executors accept a context object to decouple
 * from the GitHubService implementation in the apps layer.
 */

/** Sentinel value returned by searchCode when GitHub rate-limits the request */
export const RATE_LIMITED_SENTINEL = 'GitHub Code Search is temporarily rate-limited';

export interface SreToolContext {
  getFileContent: (path: string) => Promise<string | null>;
  searchCode: (query: string) => Promise<string>;
  listFiles: (path: string) => Promise<string[]>;
  apiCallCounter: { count: number; max: number };
}

export interface SreToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
}

const MAX_LINE_RANGE = 200;

export const SRE_TOOL_DEFINITIONS: SreToolDefinition[] = [
  {
    name: 'github_file_read',
    description:
      'Read the contents of a file from the repository. Returns the file text, truncated to 10000 characters. For files longer than ~150 lines, use `github_file_read_lines` with a targeted line range after using `github_code_search` to locate the relevant section.',
    parameters: {
      path: { type: 'string', description: 'Repository-relative file path (e.g. "apps/client/server/utils/sqs.ts")' },
    },
  },
  {
    name: 'github_code_search',
    description:
      'Search for code patterns in the repository. Returns matching file excerpts, truncated to 10000 characters.',
    parameters: {
      query: { type: 'string', description: 'Code search query (e.g. "sendToQueue error handling")' },
    },
  },
  {
    name: 'github_list_files',
    description: 'List files in a repository directory. Returns an array of file paths.',
    parameters: {
      path: {
        type: 'string',
        description: 'Repository-relative directory path (e.g. "apps/client/server/queueHandlers")',
      },
    },
  },
  {
    name: 'github_file_read_lines',
    description:
      'Read a specific line range from a file. Use when a file was truncated by github_file_read — use github_code_search first to find approximate line numbers, then read the exact region.',
    parameters: {
      path: { type: 'string', description: 'File path relative to repo root' },
      start_line: { type: 'number', description: 'First line to read (1-indexed, inclusive)' },
      end_line: {
        type: 'number',
        description: `Last line to read (1-indexed, inclusive). Maximum range: ${MAX_LINE_RANGE} lines.`,
      },
    },
  },
];

const MAX_TOOL_OUTPUT_LENGTH = 10000;

function truncate(text: string, maxLength: number = MAX_TOOL_OUTPUT_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n... [truncated at ${maxLength} chars]`;
}

export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: SreToolContext
): Promise<string> {
  // Budget check
  if (ctx.apiCallCounter.count >= ctx.apiCallCounter.max) {
    return 'Tool execution unavailable. Please complete your analysis with the information gathered so far.';
  }
  ctx.apiCallCounter.count++;

  switch (toolName) {
    case 'github_file_read': {
      const filePath = String(toolInput.path || '');
      if (!filePath) return 'Error: path parameter is required';

      const content = await ctx.getFileContent(filePath);
      if (content === null) {
        // Auto-list parent directory to help the LLM find the right file
        const parentDir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
        if (parentDir) {
          try {
            const siblings = await ctx.listFiles(parentDir);
            // ctx.listFiles is a direct context call, does NOT go through executeTool,
            // so it does NOT increment apiCallCounter. No decrement needed.
            if (siblings.length > 0) {
              return `File not found: ${filePath}\nFiles in ${parentDir}/:\n${siblings.slice(0, 30).join('\n')}`;
            }
          } catch {
            // Ignore; fall through to plain 404
          }
        }
        return `File not found: ${filePath}`;
      }
      return truncate(content);
    }

    case 'github_code_search': {
      const query = String(toolInput.query || '');
      if (!query) return 'Error: query parameter is required';

      const results = await ctx.searchCode(query);
      // Rate-limited calls didn't produce useful work; don't count against budget
      if (results.startsWith(RATE_LIMITED_SENTINEL)) {
        ctx.apiCallCounter.count--;
      }
      return truncate(results);
    }

    case 'github_list_files': {
      const path = String(toolInput.path || '');
      if (!path) return 'Error: path parameter is required';

      const files = await ctx.listFiles(path);
      if (files.length === 0) {
        return `No files found at: ${path}`;
      }
      return truncate(files.join('\n'));
    }

    case 'github_file_read_lines': {
      const filePath = String(toolInput.path || '');
      if (!filePath) return 'Error: path parameter is required';

      const startLine = Math.max(1, Math.floor(Number(toolInput.start_line) || 1));
      const endLineRaw = Math.floor(Number(toolInput.end_line) || startLine);
      // Clamp to [startLine, startLine + MAX_LINE_RANGE - 1]: handles inverted ranges (end < start)
      // and enforces the max range cap server-side regardless of what the LLM requested.
      const endLine = Math.max(startLine, Math.min(endLineRaw, startLine + MAX_LINE_RANGE - 1));

      const content = await ctx.getFileContent(filePath);
      if (content === null) return `File not found: ${filePath}`;

      const lines = content.split('\n');
      const sliced = lines.slice(startLine - 1, endLine);
      const numbered = sliced.map((line, i) => `${startLine + i}: ${line}`).join('\n');
      return truncate(numbered);
    }

    default:
      return `Unknown tool: ${toolName}`;
  }
}
