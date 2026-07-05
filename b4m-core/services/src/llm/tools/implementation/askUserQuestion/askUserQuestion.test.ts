import { describe, it, expect, beforeEach } from 'vitest';
import {
  askUserQuestionTool,
  setShowUserQuestionFn,
  MAX_QUESTIONS,
  MAX_OPTIONS_PER_QUESTION,
  MIN_OPTIONS_PER_QUESTION,
  type UserQuestionPayload,
  type UserQuestionResponse,
} from './index';

function makeOption(label = 'Option', description = 'Desc') {
  return { label, description };
}

function makeQuestion(overrides: Record<string, unknown> = {}) {
  return {
    question: 'Which color?',
    options: [makeOption('Red', 'The color red'), makeOption('Blue', 'The color blue')],
    ...overrides,
  };
}

function getToolFn() {
  const impl = askUserQuestionTool.implementation();
  return impl.toolFn;
}

function parse(result: string) {
  return JSON.parse(result);
}

describe('askUserQuestion tool', () => {
  let toolFn: ReturnType<typeof getToolFn>;
  let lastPayload: UserQuestionPayload | null;

  beforeEach(() => {
    lastPayload = null;
    setShowUserQuestionFn(async (payload: UserQuestionPayload): Promise<UserQuestionResponse> => {
      lastPayload = payload;
      return {
        answers: payload.questions.map(q => ({
          question: q.question,
          selected: [q.options[0].label],
        })),
      };
    });
    toolFn = getToolFn();
  });

  describe('argument validation', () => {
    it('rejects null args', async () => {
      const result = parse(await toolFn(null));
      expect(result.error).toContain('Invalid arguments');
    });

    it('rejects non-object args', async () => {
      const result = parse(await toolFn('string'));
      expect(result.error).toContain('Invalid arguments');
    });

    it('rejects missing questions array', async () => {
      const result = parse(await toolFn({}));
      expect(result.error).toContain('At least one question');
    });

    it('rejects empty questions array', async () => {
      const result = parse(await toolFn({ questions: [] }));
      expect(result.error).toContain('At least one question');
    });

    it(`rejects more than ${MAX_QUESTIONS} questions`, async () => {
      const questions = Array.from({ length: MAX_QUESTIONS + 1 }, () => makeQuestion());
      const result = parse(await toolFn({ questions }));
      expect(result.error).toContain(`Maximum ${MAX_QUESTIONS}`);
    });

    it('rejects non-object question entries', async () => {
      const result = parse(await toolFn({ questions: ['not an object'] }));
      expect(result.error).toContain('must be an object');
    });

    it('rejects question with empty question string', async () => {
      const result = parse(await toolFn({ questions: [{ question: '', options: [] }] }));
      expect(result.error).toContain('non-empty');
    });

    it('rejects question with missing options array', async () => {
      const result = parse(await toolFn({ questions: [{ question: 'Q?' }] }));
      expect(result.error).toContain('"options" array');
    });

    it(`rejects question with fewer than ${MIN_OPTIONS_PER_QUESTION} options`, async () => {
      const result = parse(await toolFn({ questions: [{ question: 'Q?', options: [makeOption()] }] }));
      expect(result.error).toContain(`at least ${MIN_OPTIONS_PER_QUESTION}`);
    });
  });

  describe('option normalization', () => {
    it('falls back to defaults for missing label/description', async () => {
      const result = parse(
        await toolFn({
          questions: [
            {
              question: 'Pick?',
              options: [{ label: null, description: null }, { description: 'has desc' }],
            },
          ],
        })
      );
      expect(result.error).toBeUndefined();
      expect(lastPayload).not.toBeNull();
      const opts = lastPayload!.questions[0].options;
      expect(opts[0].label).toBe('(untitled)');
      expect(opts[0].description).toBe('');
      expect(opts[1].label).toBe('(untitled)');
      expect(opts[1].description).toBe('has desc');
    });

    it(`truncates options beyond ${MAX_OPTIONS_PER_QUESTION}`, async () => {
      const options = Array.from({ length: 6 }, (_, i) => makeOption(`Opt ${i}`, `Desc ${i}`));
      const result = parse(await toolFn({ questions: [{ question: 'Q?', options }] }));
      expect(result.error).toBeUndefined();
      expect(lastPayload!.questions[0].options).toHaveLength(MAX_OPTIONS_PER_QUESTION);
    });

    it('skips non-object option entries', async () => {
      const result = parse(
        await toolFn({
          questions: [
            {
              question: 'Q?',
              options: [null, 'string', makeOption('A', 'a'), makeOption('B', 'b')],
            },
          ],
        })
      );
      expect(result.error).toBeUndefined();
      expect(lastPayload!.questions[0].options).toHaveLength(2);
    });
  });

  describe('multiSelect normalization', () => {
    it('normalizes multiSelect to boolean', async () => {
      const result = parse(await toolFn({ questions: [makeQuestion({ multiSelect: true })] }));
      expect(result.error).toBeUndefined();
      expect(lastPayload!.questions[0].multiSelect).toBe(true);
    });

    it('defaults multiSelect to false', async () => {
      const result = parse(await toolFn({ questions: [makeQuestion()] }));
      expect(result.error).toBeUndefined();
      expect(lastPayload!.questions[0].multiSelect).toBe(false);
    });
  });

  describe('successful execution', () => {
    it('passes validated payload to callback and returns response', async () => {
      const result = parse(await toolFn({ questions: [makeQuestion()] }));
      expect(result.answers).toHaveLength(1);
      expect(result.answers[0].question).toBe('Which color?');
      expect(result.answers[0].selected).toEqual(['Red']);
    });
  });

  describe('tool schema', () => {
    it('has correct name', () => {
      const impl = askUserQuestionTool.implementation();
      expect(impl.toolSchema.name).toBe('ask_user_question');
    });

    it('uses constants for limits', () => {
      const impl = askUserQuestionTool.implementation();
      const schema = impl.toolSchema.parameters;
      expect(schema.properties.questions.maxItems).toBe(MAX_QUESTIONS);
      expect(schema.properties.questions.items.properties.options.minItems).toBe(MIN_OPTIONS_PER_QUESTION);
      expect(schema.properties.questions.items.properties.options.maxItems).toBe(MAX_OPTIONS_PER_QUESTION);
    });
  });
});
