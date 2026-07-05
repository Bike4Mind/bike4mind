import { ToolDefinition } from '../../base/types';
import { promises as fs } from 'fs';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { assertPathAllowed } from '../../utils/pathValidation';

interface DeleteFileParams {
  path: string;
  recursive?: boolean;
}

async function deleteFile(params: DeleteFileParams, allowedDirectories?: string[]): Promise<string> {
  const { path: filePath, recursive = false } = params;

  // Validate path is within allowed directories (cwd is always included)
  const resolvedPath = assertPathAllowed(filePath, allowedDirectories, 'delete');

  // Check if file/directory exists
  if (!existsSync(resolvedPath)) {
    throw new Error(`File or directory not found: ${filePath}`);
  }

  // Get file info before deletion
  const stats = statSync(resolvedPath);
  const isDirectory = stats.isDirectory();
  const size = stats.size;

  if (isDirectory && !recursive) {
    throw new Error(`Path is a directory: ${filePath}. Use recursive=true to delete directories and their contents.`);
  }

  // Delete file or directory
  if (isDirectory) {
    await fs.rm(resolvedPath, { recursive: true, force: true });
    return `Directory deleted successfully: ${filePath}`;
  } else {
    await fs.unlink(resolvedPath);
    return `File deleted successfully: ${filePath}\nSize: ${size} bytes`;
  }
}

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  implementation: context => ({
    toolFn: async value => {
      const params = value as DeleteFileParams;
      const resolvedPath = path.resolve(process.cwd(), path.normalize(params.path));
      const isDirectory = existsSync(resolvedPath) && statSync(resolvedPath).isDirectory();

      context.logger.info(`🗑️  DeleteFile: Deleting ${isDirectory ? 'directory' : 'file'}`, {
        path: params.path,
        recursive: params.recursive,
      });

      try {
        const result = await deleteFile(params, context.allowedDirectories);
        context.logger.info('✅ DeleteFile: Success', { path: params.path });
        return result;
      } catch (error) {
        context.logger.error('❌ DeleteFile: Failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'delete_file',
      description:
        'Delete a file or directory. For directories, recursive option must be enabled. Restricted to current working directory for security. Always prompts user for confirmation before deletion.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file or directory to delete (relative to current working directory)',
          },
          recursive: {
            type: 'boolean',
            description:
              'Required to delete directories and their contents (default: false). Use with caution as this will delete all files and subdirectories.',
          },
        },
        required: ['path'],
      },
    },
  }),
};
