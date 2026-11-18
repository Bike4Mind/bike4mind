import { describe, expect, it } from 'vitest';
import { CreateAssistantInstructionRequestSchema } from './assistantInstruction';

describe('CreateAssistantInstructionRequestSchema', () => {
  it('trims the text', () => {
    expect(CreateAssistantInstructionRequestSchema.parse({ text: '  lead with invoices ' })).toEqual({
      text: 'lead with invoices',
    });
  });

  it('accepts exactly 280 characters', () => {
    expect(CreateAssistantInstructionRequestSchema.safeParse({ text: 'x'.repeat(280) }).success).toBe(true);
  });

  it.each([
    ['empty', { text: '' }],
    ['whitespace only', { text: '   ' }],
    ['281 characters', { text: 'x'.repeat(281) }],
    ['a non-string', { text: 42 }],
    ['missing text', {}],
  ])('rejects %s', (_label, body) => {
    expect(CreateAssistantInstructionRequestSchema.safeParse(body).success).toBe(false);
  });
});
