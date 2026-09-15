import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { existsSync, promises as fs, statSync } from 'fs';
import path from 'path';
import { formatStructureOutput } from './formatter';

interface GetFileStructureParams {
  path: string;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

export function createGetFileStructureTool(): ICompletionOptionTools {
  return {
    toolFn: async value => {
      const params = value as GetFileStructureParams;

      try {
        const cwd = process.cwd();
        const resolvedPath = path.resolve(cwd, params.path);

        if (!resolvedPath.startsWith(cwd)) {
          return 'Error: Access denied - cannot read files outside of current working directory';
        }

        if (!existsSync(resolvedPath)) {
          return `Error: File not found: ${params.path}`;
        }

        const stats = statSync(resolvedPath);
        if (stats.isDirectory()) {
          return `Error: Path is a directory, not a file: ${params.path}`;
        }

        if (stats.size > MAX_FILE_SIZE) {
          return `Error: File too large (${(stats.size / 1024 / 1024).toFixed(2)}MB). Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`;
        }

        const ext = path.extname(resolvedPath).toLowerCase();
        const { getLanguageForExtension, parseFileStructure, getSupportedLanguages } =
          await import('./treeSitterEngine');

        const languageId = getLanguageForExtension(ext);
        if (!languageId) {
          const supported = getSupportedLanguages();
          return `Error: Unsupported file type "${ext}". Supported languages: ${supported.join(', ')}`;
        }

        const sourceCode = await fs.readFile(resolvedPath, 'utf-8');
        const lineCount = sourceCode.split('\n').length;
        const items = await parseFileStructure(sourceCode, languageId);

        return formatStructureOutput(params.path, items, stats.size, lineCount);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return `Error analyzing file structure: ${errorMessage}`;
      }
    },
    toolSchema: {
      name: 'get_file_structure',
      description:
        'Extract the high-level structure of a source file (imports, exports, functions, classes, interfaces, types) using AST parsing. Returns a concise outline with line numbers. Much more efficient than file_read when you only need to understand what a file contains or exports. Use this before file_read to decide which parts of a large file to read.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path to the source file (relative to cwd or absolute within cwd). Supported: .ts, .tsx, .js, .jsx, .mjs, .cjs, .py',
          },
        },
        required: ['path'],
      },
    },
  };
}
