import { describe, expect, it } from 'vitest';
import { buildSystemMessage } from './ChatService';

const build = (modelId: string): string =>
  String(
    buildSystemMessage(['/work'], false, false, false, [], undefined, [], '', false, false, false, '', true, modelId)
      .content
  );

describe('GPT_GUIDANCE', () => {
  it('is included for a gpt model id, case-insensitively', () => {
    expect(build('gpt-5')).toContain('Keep going until the task is fully handled');
    expect(build('GPT-5-codex')).toContain('Keep going until the task is fully handled');
  });

  it('is left out for other models', () => {
    expect(build('claude-sonnet-4')).not.toContain('Keep going until the task is fully handled');
  });

  it('no longer routes end-of-turn offers into the ask tool', () => {
    expect(build('claude-sonnet-4')).not.toContain('want me to do X');
  });
});
