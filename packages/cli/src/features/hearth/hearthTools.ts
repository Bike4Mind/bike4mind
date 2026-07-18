import { z } from 'zod';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { IHearthService } from './IHearthService.js';
import { PostEventRequestSchema } from './types.js';

// Zod schemas for tool params (snake_case, LLM-facing)

const PostParamsSchema = z
  .object({
    channel_id: z.string().min(1),
    text: z.string().min(1),
    format: z.enum(['md', 'text']).optional(),
    kind: z.enum(['message', 'presence', 'artifact', 'quest.update', 'system']).optional(),
    machine_schema: z.string().optional(),
    machine_payload: z.unknown().optional(),
    thread_root_id: z.string().optional(),
    reply_to_id: z.string().optional(),
    quest_id: z.string().optional(),
  })
  // Reject rather than silently drop the payload, so the model gets feedback and retries.
  .refine(p => p.machine_payload === undefined || p.machine_schema !== undefined, {
    message: 'machine_schema is required when machine_payload is provided',
  });

const CatchupParamsSchema = z.object({
  channel_id: z.string().min(1),
  limit: z.number().min(1).optional(),
});

const DelegateParamsSchema = z.object({
  channel_id: z.string().min(1),
  target_actor_id: z.string().min(1),
  task: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Factory that creates ICompletionOptionTools[] for the Hearth feature.
 * Each tool is a pure adapter: schema + delegation to the service.
 */
export function createHearthTools(service: IHearthService): ICompletionOptionTools[] {
  return [
    createChannelsTool(service),
    createPostTool(service),
    createCatchupTool(service),
    createWatchTool(service),
    createDelegateTool(service),
  ];
}

function createChannelsTool(service: IHearthService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'hearth_channels',
      description:
        'List all Hearth channels visible to you, with their IDs and names. ' +
        'Use this FIRST to discover channel IDs before using tools that require a channel_id.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    toolFn: async () => {
      const result = await service.listChannels();
      return JSON.stringify(result);
    },
  };
}

function createPostTool(service: IHearthService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'hearth_post',
      description:
        'Append an event to a Hearth channel. Defaults to a plain message; set kind for presence/artifact/system events. ' +
        'Optionally attach a typed machine payload (machine_schema names the payload contract, e.g. "myapp.build.result@1") ' +
        'so agent consumers get structured data alongside the human-readable text. ' +
        'Use thread_root_id/reply_to_id to post into an existing thread.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel to post into (get from hearth_channels)',
          },
          text: {
            type: 'string',
            description: 'Human-readable event text (always required; every surface can render it)',
          },
          format: {
            type: 'string',
            description: 'Text format (default: md)',
            enum: ['md', 'text'],
          },
          kind: {
            type: 'string',
            description: 'Event kind (default: message)',
            enum: ['message', 'presence', 'artifact', 'quest.update', 'system'],
          },
          machine_schema: {
            type: 'string',
            description: 'Contract name for the machine payload (required if machine_payload is set)',
          },
          machine_payload: {
            type: 'object',
            description: 'Typed payload for agent consumers; not rendered to humans',
            additionalProperties: true,
          },
          thread_root_id: {
            type: 'string',
            description: 'Root event ID of the thread this event belongs to',
          },
          reply_to_id: {
            type: 'string',
            description: 'Event ID this event replies to',
          },
          quest_id: {
            type: 'string',
            description: 'Quest ID when the thread is a work object',
          },
        },
        required: ['channel_id', 'text'],
      },
    },
    toolFn: async (params: unknown) => {
      const p = PostParamsSchema.parse(params);
      const request = PostEventRequestSchema.parse({
        channelId: p.channel_id,
        kind: p.kind ?? 'message',
        human: { text: p.text, format: p.format ?? 'md' },
        machine: p.machine_schema !== undefined ? { schema: p.machine_schema, payload: p.machine_payload } : undefined,
        refs: {
          threadRootId: p.thread_root_id,
          replyToId: p.reply_to_id,
          questId: p.quest_id,
        },
      });
      const result = await service.postEvent(request);
      return JSON.stringify(result);
    },
  };
}

function createCatchupTool(service: IHearthService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'hearth_catchup',
      description:
        'Fetch every event after your cursor in a channel, ordered and gap-free, then advance the cursor. ' +
        'This is how you rebuild channel context after being away - one call, no gaps. ' +
        'Use hearth_watch instead if you want to look without consuming.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel to catch up on (get from hearth_channels)',
          },
          limit: {
            type: 'number',
            description: 'Max events to return; re-call to page through the rest',
          },
        },
        required: ['channel_id'],
      },
    },
    toolFn: async (params: unknown) => {
      const { channel_id, limit } = CatchupParamsSchema.parse(params);
      const result = await service.catchup(channel_id, { advance: true, limit });
      return JSON.stringify(result);
    },
  };
}

function createWatchTool(service: IHearthService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'hearth_watch',
      description:
        'Peek at events after your cursor in a channel WITHOUT advancing the cursor. ' +
        'Use this to check for activity while leaving the events unconsumed for a later hearth_catchup.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel to watch (get from hearth_channels)',
          },
          limit: {
            type: 'number',
            description: 'Max events to return',
          },
        },
        required: ['channel_id'],
      },
    },
    toolFn: async (params: unknown) => {
      const { channel_id, limit } = CatchupParamsSchema.parse(params);
      const result = await service.catchup(channel_id, { advance: false, limit });
      return JSON.stringify(result);
    },
  };
}

function createDelegateTool(service: IHearthService): ICompletionOptionTools {
  return {
    toolSchema: {
      name: 'hearth_delegate',
      description:
        'Delegate a task to another actor (an agent, device, or gateway) by appending a delegation event. ' +
        'The target actor executes the task and appends its result to the same channel. ' +
        'target_actor_id identifies who should act; the task text describes what to do.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The channel to post the delegation into (get from hearth_channels)',
          },
          target_actor_id: {
            type: 'string',
            description: 'ID of the actor that should execute the task',
          },
          task: {
            type: 'string',
            description: 'What the target actor should do',
          },
          payload: {
            type: 'object',
            description: 'Optional structured task parameters for the target actor',
            additionalProperties: true,
          },
        },
        required: ['channel_id', 'target_actor_id', 'task'],
      },
    },
    toolFn: async (params: unknown) => {
      const { channel_id, target_actor_id, task, payload } = DelegateParamsSchema.parse(params);
      const result = await service.postEvent({
        channelId: channel_id,
        kind: 'delegation',
        human: { text: `Delegation to ${target_actor_id}: ${task}`, format: 'text' },
        machine: {
          schema: 'hearth.delegation@1',
          // Spread first so payload keys can never clobber the canonical fields.
          payload: { ...(payload ?? {}), targetActorId: target_actor_id, task },
        },
        refs: {},
      });
      return JSON.stringify(result);
    },
  };
}
