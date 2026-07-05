import { ToolDefinition } from '../../base/types';
import { promises as fs } from 'fs';
import { existsSync, statSync } from 'fs';
import { assertPathAllowed, isPathAllowed } from '../../utils/pathValidation';

interface FileReadParams {
  path: string;
  encoding?: 'utf-8' | 'ascii' | 'base64';
  offset?: number;
  limit?: number;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

async function readFileContent(params: FileReadParams, allowedDirectories?: string[]): Promise<string> {
  const { path: filePath, encoding = 'utf-8', offset = 0, limit } = params;

  // Validate path is within allowed directories (cwd is always included)
  const resolvedPath = assertPathAllowed(filePath, allowedDirectories, 'read');

  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = statSync(resolvedPath);
  if (stats.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${filePath}`);
  }

  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`
    );
  }

  const isBinary = await checkIfBinary(resolvedPath);
  if (isBinary && encoding === 'utf-8') {
    throw new Error(
      `File appears to be binary. Use encoding 'base64' to read binary files, or specify a different encoding.`
    );
  }

  const content = await fs.readFile(resolvedPath, encoding);

  // Handle pagination for text files
  if (typeof content === 'string') {
    const lines = content.split('\n');
    const totalLines = lines.length;

    if (offset < 0) {
      throw new Error(`Invalid offset: ${offset}. Offset must be 0 or greater.`);
    }

    if (offset >= totalLines) {
      return `No content to show. File has ${totalLines} lines, but offset is ${offset}.\n(offset is 0-based, so valid range is 0-${Math.max(0, totalLines - 1)})`;
    }

    if (limit !== undefined && limit > 0) {
      const endLine = Math.min(offset + limit, totalLines);
      const paginatedContent = lines.slice(offset, endLine).join('\n');

      if (endLine < totalLines) {
        const nextOffset = endLine;
        return `${paginatedContent}\n\n... Showing lines ${offset + 1}-${endLine} of ${totalLines} total lines (${stats.size} bytes total).\nTo read more, use offset: ${nextOffset}`;
      }

      return `${paginatedContent}\n\n... Showing lines ${offset + 1}-${endLine} of ${totalLines} total lines (${stats.size} bytes total). End of file reached.`;
    }

    if (offset > 0) {
      const paginatedContent = lines.slice(offset).join('\n');
      return `${paginatedContent}\n\n... Showing lines ${offset + 1}-${totalLines} of ${totalLines} total lines (${stats.size} bytes total).`;
    }

    return content;
  }

  return `[Binary content, ${stats.size} bytes, base64 encoded]\n${content}`;
}

/**
 * Simple binary file detection by reading first 8KB and checking for null bytes
 */
async function checkIfBinary(filePath: string): Promise<boolean> {
  const buffer = Buffer.alloc(8192);
  const fd = await fs.open(filePath, 'r');

  try {
    const { bytesRead } = await fd.read(buffer, 0, 8192, 0);
    const chunk = buffer.slice(0, bytesRead);

    // Check for null bytes (common in binary files)
    return chunk.includes(0);
  } finally {
    await fd.close();
  }
}

export const fileReadTool: ToolDefinition = {
  name: 'file_read',
  implementation: context => ({
    toolFn: async value => {
      const params = value as FileReadParams;
      context.logger.info('📄 FileRead: Reading file', { path: params.path });

      try {
        const content = await readFileContent(params, context.allowedDirectories);
        // Use validated resolved path instead of re-resolving
        const { resolvedPath: validatedPath } = isPathAllowed(params.path, context.allowedDirectories);
        const stats = statSync(validatedPath);

        context.logger.info('✅ FileRead: Success', {
          path: params.path,
          size: stats.size,
          lines: typeof content === 'string' ? content.split('\n').length : 'binary',
        });

        return content;
      } catch (error) {
        context.logger.error('❌ FileRead: Failed', error);
        // Return the error as the tool result so the agent can see and handle it.
        const errorMessage = error instanceof Error ? error.message : String(error);
        return `Error reading file: ${errorMessage}`;
      }
    },
    toolSchema: {
      name: 'file_read',
      description:
        'Read the contents of a file from the local filesystem. Supports text files with various encodings. Files are restricted to the current working directory and subdirectories for security. IMPORTANT: Read files completely by default (without offset/limit). Only use offset/limit for extremely large files (thousands of lines) that exceed context limits. Never re-read the same file multiple times - refer to previous reads in conversation history instead.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path to the file to read (relative to current working directory or absolute path within working directory)',
          },
          encoding: {
            type: 'string',
            description: 'File encoding (default: utf-8). Use base64 for binary files.',
            enum: ['utf-8', 'ascii', 'base64'],
          },
          offset: {
            type: 'number',
            description:
              'OPTIONAL: For text files, the 0-based line number to start reading from. Only use for extremely large files (thousands of lines) that cannot fit in context. Default behavior is to read the entire file, which is preferred for most cases.',
          },
          limit: {
            type: 'number',
            description:
              'OPTIONAL: Maximum number of lines to read from offset. Only use for extremely large files (thousands of lines) that cannot fit in context. Default behavior is to read the entire file, which is preferred for most cases.',
          },
        },
        required: ['path'],
      },
    },
  }),
};
