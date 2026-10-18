import { describe, expect, it } from 'vitest';
import { BEDROCK_ANTHROPIC_PREFIX, claudeFamilyVersion, parseClaudeModelId } from './claudeModelId';

describe('parseClaudeModelId', () => {
  it.each([
    ['claude-opus-4-5-20251101', 'opus', 4, 5],
    ['claude-sonnet-5', 'sonnet', 5, null],
    ['claude-fable-5-1', 'fable', 5, 1],
    ['claude-opus-4-10', 'opus', 4, 10],
    ['claude-opus-4-20250514', 'opus', 4, null],
    ['claude-opus-5-5[1m]', 'opus', 5, 5],
    ['claude-opus-4-7@20260101', 'opus', 4, 7],
    ['claude-opus-4-5-latest', 'opus', 4, 5],
    ['global.anthropic.claude-sonnet-5-5', 'sonnet', 5, 5],
    ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'haiku', 4, 5],
    ['us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0', 'sonnet', 4, 5],
    ['anthropic.claude-opus-4-8', 'opus', 4, 8],
  ])('reads %s', (id, family, major, minor) => {
    expect(parseClaudeModelId(id)).toEqual({ family, major, minor });
  });

  it.each([
    'claude-opus-5-5-1',
    'claude-sonnet-4-5-2025',
    'claude-opus-4-7-',
    'claude-opus-',
    'claude-nova-5',
    'claude-mythos-preview',
    'claude-3-5-sonnet-latest',
    'anthropic.claude-v2:1',
    'anthropic/claude-opus-5-5',
    'foo.claude-opus-4-7',
    'xclaude-opus-4-7',
    'CLAUDE-OPUS-4-7',
    'gpt-4o',
    '',
  ])('reads %s as null', id => {
    expect(parseClaudeModelId(id)).toBeNull();
  });

  it('keys a version without a minor as family-major', () => {
    expect(claudeFamilyVersion('claude-opus-5')).toBe('opus-5');
    expect(claudeFamilyVersion('eu.anthropic.claude-opus-5-5-v1:0')).toBe('opus-5-5');
  });

  it('exposes the Bedrock prefix that isClaudeModelId also uses', () => {
    expect(new RegExp(`^${BEDROCK_ANTHROPIC_PREFIX}claude-`).test('jp.anthropic.claude-opus-4-8')).toBe(true);
  });
});
