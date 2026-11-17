import { describe, expect, it } from 'vitest';
import { EndUserIdSchema } from './endUserId';
import { CompletionRequestSchema } from './cliCompletions';
import { ttsRequestSchema } from '../voiceGeneration';

describe('EndUserIdSchema', () => {
  it.each(['a', 'customer_42', 'tenant:user-7', 'A'.repeat(64)])('accepts %j', value => {
    expect(EndUserIdSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['a space', 'customer 42'],
    ['a dot', 'customer.42'],
    ['an email', 'jane@example.com'],
    ['a bare @', '@'],
  ])('rejects %s', (_name, value) => {
    expect(EndUserIdSchema.safeParse(value).success).toBe(false);
  });

  it('is an optional field of the completions and TTS request bodies', () => {
    const completion = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    expect(CompletionRequestSchema.parse({ ...completion, end_user_id: 'u1' }).end_user_id).toBe('u1');
    expect(CompletionRequestSchema.safeParse(completion).success).toBe(true);
    expect(CompletionRequestSchema.safeParse({ ...completion, end_user_id: 'a@b' }).success).toBe(false);
    expect(ttsRequestSchema.parse({ text: 'hi', end_user_id: 'u1' }).end_user_id).toBe('u1');
    expect(ttsRequestSchema.safeParse({ text: 'hi', end_user_id: 'a@b' }).success).toBe(false);
  });
});
