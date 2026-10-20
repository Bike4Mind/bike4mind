import { ToolDefinition } from '../../base/types';
import { DecisionToolRequestSchema } from './request';
export { DecisionToolRequestSchema } from './request';

/**
 * Typed decision checks (predicate / choice / score) answered with calibrated probabilities,
 * without spending a generation turn. Execution is host-injected (see `ToolContext.decide`): the
 * runner, its credit hold and provider retry live in the app tier, so this tool only forwards.
 */
export const decideTool: ToolDefinition = {
  name: 'decide',
  implementation: context => ({
    toolFn: async value => {
      const run = context.decide;
      if (!run) throw new Error('decide is not available on this surface');
      const { input, questions, model } = DecisionToolRequestSchema.parse(value);
      const result = await run({
        userId: context.userId,
        user: context.user,
        logger: context.logger,
        authOrigin: context.authOrigin,
        apiKeyId: context.apiKeyId,
        organizationId: context.organizationId,
        request: { model, input, questions },
      });
      return JSON.stringify({ id: result.id, model: result.model, answers: result.answers });
    },
    toolSchema: {
      name: 'decide',
      description:
        'Answer typed questions about text with calibrated probabilities: classify, route or score ' +
        'without spending a full answer. Types are predicate (probability), choice (probabilities over ' +
        'values) and score (probabilities over an ordered scale). Answers return in question order; a ' +
        'declined question is a `refusal`, not an error.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Text to judge.' },
          questions: {
            type: 'array',
            description: 'One to twenty, each judged independently.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['predicate', 'choice', 'score'] },
                name: { type: 'string', description: 'Unique within the call.' },
                instructions: { type: 'string', description: 'What to judge.' },
                choices: {
                  type: 'array',
                  description: 'Required for `choice`.',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['value'],
                  },
                },
                levels: {
                  type: 'array',
                  description: 'Required for `score`: lowest first.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['label'],
                  },
                },
              },
              required: ['type', 'name', 'instructions'],
            },
          },
          model: {
            type: 'string',
            description: 'Optional model id; omit for the deployment default.',
          },
        },
        required: ['input', 'questions'],
      },
    },
  }),
};
