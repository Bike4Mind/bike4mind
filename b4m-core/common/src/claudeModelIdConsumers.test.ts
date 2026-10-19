import { describe, expect, it } from 'vitest';
import { supportsToolChanges, supportsToolSearch } from './claudeToolCapabilities';
import { ModelBackend, supportsForcedToolChoice } from './models';
import { tokenEstimateMultiplier } from './utils/tokenEstimateMultiplier';

// [id, tool search, tool changes, token multiplier, forced tool choice]. Tool flags use the backend the id's
// own spelling implies. Forced tool choice reads its own permissive deny-list, so it can disagree with the rest.
const CONSUMER_TABLE: Array<[string, boolean, boolean, number, boolean]> = [
  ['claude-opus-4-5-20251101', true, false, 1.09, true],
  ['claude-haiku-4-5-20251001', true, false, 1.09, true],
  ['claude-opus-4-7-20260416', true, false, 1.5, true],
  ['claude-opus-4-8', true, true, 1.5, true],
  ['claude-sonnet-5', true, false, 1.5, true],
  ['claude-opus-5-5', true, true, 1.5, false],
  ['claude-haiku-5-5', true, true, 1.5, true],
  ['claude-fable-5-1', true, true, 1, false],
  ['claude-mythos-5', true, true, 1, true],
  ['claude-opus-4-5-latest', true, false, 1.09, true],
  ['claude-opus-5-5[1m]', true, true, 1.5, false],
  ['claude-opus-4-7[1m]', true, false, 1.5, true],
  ['claude-opus-4-7@20260101', true, false, 1.5, true],
  ['global.anthropic.claude-sonnet-5-5', true, true, 1.5, false],
  ['us.anthropic.claude-haiku-4-5-20251001-v1:0', true, false, 1.09, true],
  ['anthropic/claude-opus-5-5', false, false, 1, false],
  ['claude-3-5-sonnet-latest', false, false, 1, true],
  ['us.anthropic.claude-opus-4-20250514-v1:0', false, false, 1, true],
  ['claude-opus-4-10', false, false, 1.5, true],
  ['claude-opus-5-5-1', false, false, 1, false],
  ['vendor.claude-sonnet-5-5', false, false, 1, false],
  ['foo.claude-opus-4-7', false, false, 1, true],
  ['claude-sonnet-4-5-2025', false, false, 1, true],
  ['gpt-4o', false, false, 1, true],
];

describe('Claude id consumers', () => {
  it.each(CONSUMER_TABLE)('%s', (id, toolSearch, toolChanges, multiplier, forcedToolChoice) => {
    const backend = id.includes('anthropic.') ? ModelBackend.Bedrock : ModelBackend.Anthropic;

    expect([
      supportsToolSearch({ id, backend }),
      supportsToolChanges({ id, backend }),
      tokenEstimateMultiplier(id),
      supportsForcedToolChoice(id),
    ]).toEqual([toolSearch, toolChanges, multiplier, forcedToolChoice]);
  });
});
