import { describe, expect, it } from 'vitest';
import { matchesOpenAIResponseModel } from './openaiModelIdentity';

const NOW = Date.parse('2026-11-26T00:00:00Z');
const cases: [string, unknown, boolean][] = [
  ['gpt-4o', 'gpt-4o', true],
  ['gpt-4o', 'gpt-4o-2024-08-06', true],
  ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18', true],
  ['gpt-4.1', 'gpt-4.1-2025-04-14', true],
  ['gpt-5', 'gpt-5-2025-08-07', true],
  ['o3', 'o3-2025-04-16', true],
  ['gpt-5-chat-latest', 'gpt-5-chat-latest', true],
  ['gpt-5-chat-latest', 'gpt-5-chat-2025-08-07', true],
  ['gpt-4', 'gpt-4-0613', true],
  ['gpt-4', 'gpt-4-0314', true],
  ['gpt-4-turbo', 'gpt-4-turbo-2024-04-09', true],
  ['gpt-4o-2024-08-06', 'gpt-4o-2024-08-06', true],
  ['ft:custom', 'ft:custom', true],
  ['', '', false],
  ['gpt-4o', undefined, false],
  ['gpt-4o', null, false],
  ['gpt-4o', 42, false],
  ['gpt-4o', '', false],
  ['gpt-4o', 'different-model', false],
  ['gpt-4o', 'gpt-4o-mini-2024-07-18', false],
  ['gpt-4o-mini', 'gpt-4o-2024-08-06', false],
  ['gpt-4o', 'gpt-4o-2024-08-06-extra', false],
  ['gpt-4o', 'gpt-4o-20990101', false],
  ['gpt-4o', 'gpt-4o-2099-01-01', false],
  ['gpt-4o', 'gpt-4o-2024-02-30', false],
  ['gpt-4o', 'gpt-4o-2024-13-01', false],
  ['gpt-4o', 'gpt-4o-2024-8-6', false],
  ['gpt-4o', 'gpt-4o-2024-08-06-2025-01-01', false],
  ['gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', false],
  ['gpt-4o-2024-08-06', 'gpt-4o-2024-08-06-2025-01-01', false],
  ['gpt-4-0613', 'gpt-4-0314', false],
  ['gpt-4', 'gpt-4-9999', false],
  ['ft:custom', 'ft:custom-2025-01-01', false],
  ['claude-sonnet-4-6', 'claude-sonnet-4-6-2026-01-01', false],
];

describe('direct OpenAI response identity', () => {
  it.each(cases)('%s -> %s accepts=%s', (requested, returned, expected) => {
    expect(matchesOpenAIResponseModel(requested, returned, NOW)).toBe(expected);
  });
});
