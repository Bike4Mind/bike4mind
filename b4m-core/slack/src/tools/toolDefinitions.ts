import type { ToolDefinition } from '@bike4mind/services/llm';
import { isImageServeable } from '@bike4mind/common';
import { generateHelpMessage } from './slackbotHelp';
import { listCuratedFiles, getCuratedFiles } from './listCuratedFiles';
import { z } from 'zod';
import { notebookNew } from './notebookNew';
import { notebookStatus } from './notebookStatus';

export const slackbotHelpToolDef: ToolDefinition = {
  name: 'slackbot_help',
  implementation: () => ({
    toolFn: async () => generateHelpMessage(),
    toolSchema: {
      name: 'slackbot_help',
      description:
        'Display help information showing available Slack bot agents, commands, and usage tips. Call this tool when the user asks for help, types "/help", or asks what the bot can do.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  }),
};

export const listCuratedFilesToolDef: ToolDefinition = {
  name: 'list_curated_files',
  implementation: context => ({
    toolFn: async (rawParams?: unknown) => {
      const params = (rawParams || {}) as { limit?: number };
      const result = await listCuratedFiles({ userId: context.userId, limit: params.limit });
      return result.message;
    },
    toolSchema: {
      name: 'list_curated_files',
      description:
        'List curated notebook files available for the user. Call this when the user asks to "list files", "show files", or "what files do I have".',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of files to return (default: 5)' },
        },
        required: [],
      },
    },
  }),
};

export const shareCuratedFileToolDef: ToolDefinition = {
  name: 'share_curated_file',
  implementation: context => ({
    toolFn: async (rawParams?: unknown) => {
      const params = z.object({ fileName: z.string().max(255).optional() }).parse(rawParams ?? {});
      if (!context.requestConfirmation || !context.slackDestination) {
        return 'File sharing requires a Slack confirmation. Request it from Slack.';
      }
      const files = await getCuratedFiles(
        context.userId,
        {
          limit: params.fileName ? 5 : 1,
          fileName: params.fileName,
        },
        context.logger
      );

      if (!files || files.length === 0) {
        const hint = params.fileName
          ? `No curated file found matching "${params.fileName}". Try asking to "list files" to see available files.`
          : 'No curated files found. Please curate a notebook in the app first.';
        return hint;
      }

      const file = files[0];
      if (!file.filePath) {
        return 'Curated file not found.';
      }

      // Refuse to mint a share link for a held/blocked uploaded image.
      if (!isImageServeable(file)) {
        return 'This file is not available right now.';
      }

      if (params.fileName && files.length > 1) {
        return 'Multiple files match. Please specify the exact file name.';
      }
      await context.requestConfirmation({
        tool: 'share_curated_file',
        params: { fileId: file.id, fileName: file.fileName, userId: context.userId, ...context.slackDestination },
        ts: Date.now(),
      });
      return 'File sharing is awaiting your Confirm button click. No download link has been created.';
    },
    toolSchema: {
      name: 'share_curated_file',
      description:
        'Request confirmation to share a curated notebook file. Call this when the user asks to "share file", "send file", or "share my latest file". Optionally specify a file name.',
      parameters: {
        type: 'object',
        properties: {
          fileName: {
            type: 'string',
            description: 'Name or partial name of the file to share. If omitted, shares the most recent file.',
          },
        },
        required: [],
      },
    },
  }),
};

export const notebookNewToolDef: ToolDefinition = {
  name: 'notebook_new',
  implementation: context => ({
    toolFn: async () => {
      const result = await notebookNew({
        user: context.user,
        slackUserId: context.user.slackSettings?.slackUserId || '',
        logger: context.logger,
      });
      return result.message;
    },
    toolSchema: {
      name: 'notebook_new',
      description:
        'Create a new notebook and set it as the default for Slack conversations. Call this when the user types "/notebook new" or asks to create a new notebook.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  }),
};

export const notebookStatusToolDef: ToolDefinition = {
  name: 'notebook_status',
  implementation: context => ({
    toolFn: async () => {
      const result = notebookStatus({ user: context.user });
      return result.message;
    },
    toolSchema: {
      name: 'notebook_status',
      description:
        'Show the current notebook configuration. Call this when the user types "/notebook status" or asks about their notebook settings.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  }),
};

/** All Slack tool definitions, keyed by tool name */
export const slackToolDefinitions: Record<string, ToolDefinition> = {
  slackbot_help: slackbotHelpToolDef,
  list_curated_files: listCuratedFilesToolDef,
  share_curated_file: shareCuratedFileToolDef,
  notebook_new: notebookNewToolDef,
  notebook_status: notebookStatusToolDef,
};
