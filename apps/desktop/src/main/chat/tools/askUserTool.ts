import {
  ASK_USER_TOOL_NAME,
  formatQuestionResult,
  MAX_DESCRIPTION_CHARS,
  MAX_HEADER_CHARS,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  parseOutcome,
  parseQuestions,
} from '@shared/questions';
import type { ToolDefinition } from './types';

/**
 * The model asking the user to decide something, answered on a card in the transcript.
 *
 * Not gated: a question changes nothing, so the card IS the interaction. ChatService sees
 * `interactive`, waits for the card, and folds the outcome into this call's input as `outcome`;
 * `run` only turns that into the result the model reads. Absent an outcome - run outside the
 * chat loop, or by a model that never reached the card - there is nobody to have answered.
 */
export const askUser: ToolDefinition = {
  interactive: true,
  schema: {
    name: ASK_USER_TOOL_NAME,
    description: [
      'Ask the user one to four multiple-choice questions and wait for their answers. The turn',
      'pauses on a card they answer with a click; you continue in the same turn.',
      '',
      "Use it only when you are blocked on a decision that is genuinely the user's to make: a",
      'preference, a trade-off between valid approaches, a requirement you cannot infer. Do not',
      "use it for anything you can answer from the code, the project's conventions or a sensible",
      'default - make that call and say so. Do not use it to ask "should I proceed?" or to ask',
      'permission to do what the user already asked for.',
      '',
      'Put the option you recommend first and append " (Recommended)" to its label. Never include',
      'an "Other" option: the card always adds one with a text field. Set multiSelect when more',
      'than one option can apply. If the user skips, proceed with your best judgment or stop and',
      'ask in plain text.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: `1 to ${MAX_QUESTIONS} questions, shown together.`,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The full question, ending with a question mark.' },
              header: {
                type: 'string',
                description: `A short label for the question, at most ${MAX_HEADER_CHARS} characters.`,
              },
              options: {
                type: 'array',
                description: `${MIN_OPTIONS} to ${MAX_OPTIONS} distinct choices, without an "Other".`,
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: 'The choice, kept short (a few words); put detail in the description.',
                    },
                    description: {
                      type: 'string',
                      description: `What choosing it means or implies, at most ${MAX_DESCRIPTION_CHARS} characters.`,
                    },
                  },
                  required: ['label', 'description'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow more than one option. Default false.' },
            },
            required: ['question', 'header', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },

  async run(input) {
    const parsed = parseQuestions(input.questions);
    if ('error' in parsed) throw new Error(parsed.error);
    const outcome = parseOutcome(input.outcome);
    if (!outcome) throw new Error('The user could not be asked in this context; use your best judgment.');
    return formatQuestionResult(parsed.questions, outcome);
  },
};
