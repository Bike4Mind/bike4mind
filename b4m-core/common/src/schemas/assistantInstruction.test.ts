import { describe, expect, it } from 'vitest';
import { CreateAssistantInstructionRequestSchema } from './assistantInstruction';
import { createAssistantInstructionContract } from '../api-contract/contracts/assistantInstructions.contract';

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

describe('createAssistantInstruction error contract', () => {
  it('retains the cap classifier and accepts a generic bad request without one', () => {
    const schema = createAssistantInstructionContract.responses[400].schema;
    const capped = { error: 'Full', errorCode: 'instruction_limit_reached' };
    expect(schema.parse(capped)).toEqual(capped);
    expect(schema.parse({ error: 'Account unavailable' })).toEqual({ error: 'Account unavailable' });
  });
});
