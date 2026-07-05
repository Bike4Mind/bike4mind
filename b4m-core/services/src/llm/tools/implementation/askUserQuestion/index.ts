import { ToolDefinition } from '../../base/types';

// Types

export interface QuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface UserQuestionPayload {
  questions: UserQuestion[];
}

export interface UserQuestionAnswer {
  question: string;
  selected: string[];
}

export interface UserQuestionResponse {
  answers: UserQuestionAnswer[];
}

// Module-level callback setter

type ShowUserQuestionFn = (payload: UserQuestionPayload) => Promise<UserQuestionResponse>;

let _showUserQuestion: ShowUserQuestionFn | null = null;

/**
 * Inject the CLI callback that displays the question UI.
 * Called once during CLI startup wiring.
 */
export function setShowUserQuestionFn(fn: ShowUserQuestionFn): void {
  _showUserQuestion = fn;
}

// Constants

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS_PER_QUESTION = 4;
export const MIN_OPTIONS_PER_QUESTION = 2;

// Runtime validation

interface ValidatedQuestion {
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}

function validateArgs(args: unknown): { questions: ValidatedQuestion[] } | { error: string } {
  if (args === null || typeof args !== 'object') {
    return { error: 'Invalid arguments: expected an object.' };
  }

  const obj = args as Record<string, unknown>;

  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    return { error: 'At least one question is required.' };
  }

  if (obj.questions.length > MAX_QUESTIONS) {
    return { error: `Maximum ${MAX_QUESTIONS} questions allowed.` };
  }

  const questions: ValidatedQuestion[] = [];
  for (const raw of obj.questions) {
    if (raw === null || typeof raw !== 'object') {
      return { error: 'Each question must be an object.' };
    }

    const q = raw as Record<string, unknown>;

    if (typeof q.question !== 'string' || q.question.trim() === '') {
      return { error: 'Each question must have a non-empty "question" string.' };
    }

    if (!Array.isArray(q.options)) {
      return { error: `Question "${q.question}" must have an "options" array.` };
    }

    const options: Array<{ label: string; description: string }> = [];
    for (const rawOpt of q.options.slice(0, MAX_OPTIONS_PER_QUESTION)) {
      if (rawOpt === null || typeof rawOpt !== 'object') continue;
      const opt = rawOpt as Record<string, unknown>;
      options.push({
        label: typeof opt.label === 'string' ? opt.label : '(untitled)',
        description: typeof opt.description === 'string' ? opt.description : '',
      });
    }

    if (options.length < MIN_OPTIONS_PER_QUESTION) {
      return { error: `Question "${q.question}" must have at least ${MIN_OPTIONS_PER_QUESTION} options.` };
    }

    questions.push({
      question: q.question,
      options,
      multiSelect: q.multiSelect === true ? true : undefined,
    });
  }

  return { questions };
}

// Tool Definition

export const askUserQuestionTool: ToolDefinition = {
  name: 'ask_user_question',
  implementation: () => ({
    toolFn: async (args: unknown): Promise<string> => {
      if (!_showUserQuestion) {
        return JSON.stringify({
          error: 'ask_user_question is only available in the CLI environment.',
        });
      }

      const validated = validateArgs(args);
      if ('error' in validated) {
        return JSON.stringify({ error: validated.error });
      }

      const payload: UserQuestionPayload = {
        questions: validated.questions.map(q => ({
          question: q.question,
          options: q.options,
          multiSelect: q.multiSelect === true,
        })),
      };

      const response = await _showUserQuestion(payload);
      return JSON.stringify(response);
    },
    toolSchema: {
      name: 'ask_user_question',
      description:
        'Ask the user one or more structured questions with selectable options. ' +
        'Use this when you need clarification, user preferences, or decisions. ' +
        `Each question has ${MIN_OPTIONS_PER_QUESTION}-${MAX_OPTIONS_PER_QUESTION} options. The user can also provide free-text via "Other". ` +
        'For multiSelect questions, the user can pick multiple options.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: `Array of questions to ask (1-${MAX_QUESTIONS} questions)`,
            minItems: 1,
            maxItems: MAX_QUESTIONS,
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The question to ask. Should be clear and end with a question mark.',
                },
                options: {
                  type: 'array',
                  description: `Available choices (${MIN_OPTIONS_PER_QUESTION}-${MAX_OPTIONS_PER_QUESTION} options). An "Other" free-text option is always appended automatically.`,
                  minItems: MIN_OPTIONS_PER_QUESTION,
                  maxItems: MAX_OPTIONS_PER_QUESTION,
                  items: {
                    type: 'object',
                    properties: {
                      label: {
                        type: 'string',
                        description: 'Short display text for this option (1-5 words)',
                      },
                      description: {
                        type: 'string',
                        description: 'Explanation of what this option means',
                      },
                    },
                    required: ['label', 'description'],
                  },
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'If true, the user can select multiple options. Default: false.',
                  default: false,
                },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  }),
};
