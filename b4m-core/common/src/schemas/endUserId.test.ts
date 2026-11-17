import { describe, expect, it } from 'vitest';
import { EndUserIdSchema, isValidEndUserId } from './endUserId';
import { CompletionRequestSchema } from './cliCompletions';
import { ttsRequestSchema } from '../voiceGeneration';

describe('isValidEndUserId', () => {
  it.each(['a', 'customer_42', 'tenant:user-7', 'A'.repeat(64)])('accepts %j', value => {
    expect(isValidEndUserId(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['a space', 'customer 42'],
    ['a dot', 'customer.42'],
    ['an email', 'jane@example.com'],
    ['a bare @', '@'],
  ])('rejects %s', (_name, value) => {
    expect(isValidEndUserId(value)).toBe(false);
  });
});

describe('EndUserIdSchema', () => {
  it('passes any string through so a malformed value is not a contract 422', () => {
    expect(EndUserIdSchema.safeParse('').success).toBe(true);
    expect(EndUserIdSchema.safeParse('a@b').success).toBe(true);
    expect(EndUserIdSchema.safeParse(42).success).toBe(false);
  });

  it('is an optional field of the completions and TTS request bodies', () => {
    const completion = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    expect(CompletionRequestSchema.parse({ ...completion, end_user_id: 'u1' }).end_user_id).toBe('u1');
    expect(CompletionRequestSchema.safeParse(completion).success).toBe(true);
    expect(CompletionRequestSchema.parse({ ...completion, end_user_id: 'a@b' }).end_user_id).toBe('a@b');
    expect(ttsRequestSchema.parse({ text: 'hi', end_user_id: 'u1' }).end_user_id).toBe('u1');
    expect(ttsRequestSchema.parse({ text: 'hi', end_user_id: 'a@b' }).end_user_id).toBe('a@b');
  });
});
