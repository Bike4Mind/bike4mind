import { ToolDefinition } from '../../base/types';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { assertPathAllowed } from '../../utils/pathValidation';

interface CreateFileParams {
  path: string;
  content: string;
  createDirectories?: boolean;
}

async function createFile(params: CreateFileParams, allowedDirectories?: string[]): Promise<string> {
  const { path: filePath, content, createDirectories = true } = params;

  // Validate path is within allowed directories (cwd is always included)
  const resolvedPath = assertPathAllowed(filePath, allowedDirectories, 'create');

  // Check if file already exists
  const fileExists = existsSync(resolvedPath);
  const action = fileExists ? 'overwritten' : 'created';

  // Create parent directories if needed
  if (createDirectories) {
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.writeFile(resolvedPath, content, 'utf-8');

  const stats = await fs.stat(resolvedPath);
  const lines = content.split('\n').length;

  return `File ${action} successfully: ${filePath}\nSize: ${stats.size} bytes\nLines: ${lines}`;
}

export const createFileTool: ToolDefinition = {
  name: 'create_file',
  implementation: context => ({
    toolFn: async value => {
      const params = value as CreateFileParams;
      const fileExists = existsSync(path.resolve(process.cwd(), path.normalize(params.path)));

      context.logger.info(`📝 CreateFile: ${fileExists ? 'Overwriting' : 'Creating'} file`, {
        path: params.path,
        size: params.content.length,
      });

      try {
        const result = await createFile(params, context.allowedDirectories);
        context.logger.info('✅ CreateFile: Success', { path: params.path });
        return result;
      } catch (error) {
        context.logger.error('❌ CreateFile: Failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'create_file',
      description:
        'Create a new file or overwrite an existing file with the provided content. Will create parent directories if they do not exist. Restricted to current working directory for security. Always prompts user for confirmation before writing.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path where the file should be created (relative to current working directory)',
          },
          content: {
            type: 'string',
            description: 'Content to write to the file',
          },
          createDirectories: {
            type: 'boolean',
            description: 'Create parent directories if they do not exist (default: true)',
          },
        },
        required: ['path', 'content'],
      },
    },
  }),
};
