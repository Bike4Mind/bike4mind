import { describe, expect, it } from 'vitest';
import { PlatformEndUserIdSchema } from './platformEndUser';
import { CompletionRequestSchema } from './cliCompletions';
import { ttsRequestSchema } from '../voiceGeneration';

describe('PlatformEndUserIdSchema', () => {
  it.each(['a', 'player-42', 'tenant:user_7', 'A'.repeat(64)])('accepts %j', value => {
    expect(PlatformEndUserIdSchema.safeParse(value).success).toBe(true);
  });

  it.each(['', 'A'.repeat(65), 'jane@example.com', 'has space', 'a/b', 'caf\u00e9', 42])('rejects %j', value => {
    expect(PlatformEndUserIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('end_user_id on the AI request schemas', () => {
  const completion = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

  it('is optional and validated on completions', () => {
    expect(CompletionRequestSchema.safeParse(completion).success).toBe(true);
    expect(CompletionRequestSchema.safeParse({ ...completion, end_user_id: 'p-1' }).data?.end_user_id).toBe('p-1');
    const bad = CompletionRequestSchema.safeParse({ ...completion, end_user_id: 'a@b' });
    expect(bad.error?.issues[0]?.path).toEqual(['end_user_id']);
  });

  it('is optional and validated on text-to-speech', () => {
    expect(ttsRequestSchema.safeParse({ text: 'hi' }).success).toBe(true);
    expect(ttsRequestSchema.safeParse({ text: 'hi', end_user_id: 'p-1' }).data?.end_user_id).toBe('p-1');
    expect(ttsRequestSchema.safeParse({ text: 'hi', end_user_id: '' }).success).toBe(false);
  });
});
