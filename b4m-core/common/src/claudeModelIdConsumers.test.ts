import { describe, expect, it } from 'vitest';
import { supportsToolChanges, supportsToolSearch } from './claudeToolCapabilities';
import { ModelBackend, supportsForcedToolChoice } from './models';
import { tokenEstimateMultiplier } from './utils/tokenEstimateMultiplier';

// [id, tool search, tool changes, token multiplier, forced tool choice] as each consumer answered before the
// three Claude id parsers were merged. Tool flags use the backend the id's own spelling implies.
const CONSUMER_TABLE: Array<[string, boolean, boolean, number, boolean]> = [
  ['claude-opus-4-5-20251101', true, false, 1.09, true],
  ['claude-sonnet-4-5-20250929', true, false, 1.09, true],
  ['claude-haiku-4-5-20251001', true, false, 1.09, true],
  ['claude-opus-4-7-20260416', true, false, 1.5, true],
  ['claude-opus-4-7', true, false, 1.5, true],
  ['claude-opus-4-8', true, true, 1.5, true],
  ['claude-opus-5', true, true, 1.5, true],
  ['claude-opus-5-5', true, true, 1.5, false],
  ['claude-sonnet-5', true, false, 1.5, true],
  ['claude-sonnet-5-5', true, true, 1.5, false],
  ['claude-haiku-5-5', true, true, 1.5, true],
  ['claude-fable-5', true, true, 1, true],
  ['claude-fable-5-1', true, true, 1, false],
  ['claude-mythos-5', true, true, 1, true],
  ['claude-mythos-5-1', true, true, 1, false],
  ['claude-opus-4-5-latest', true, false, 1.09, true],
  ['claude-opus-5-5[1m]', true, true, 1.5, false],
  ['claude-sonnet-5-5[1m]', true, true, 1.5, false],
  ['claude-sonnet-5-5@20260101', true, true, 1.5, false],
  ['anthropic.claude-opus-4-8', true, true, 1.5, true],
  ['global.anthropic.claude-sonnet-5-5', true, true, 1.5, false],
  ['global.anthropic.claude-sonnet-5', true, false, 1.5, true],
  ['us.anthropic.claude-haiku-4-5-20251001-v1:0', true, false, 1.09, true],
  ['eu.anthropic.claude-haiku-4-5-20251001-v1:0', true, false, 1.09, true],
  ['apac.anthropic.claude-sonnet-5', true, false, 1.5, true],
  ['jp.anthropic.claude-opus-4-8', true, true, 1.5, true],
  ['us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0', true, false, 1.09, true],
  ['us.anthropic.claude-opus-5-5-v1:0', true, true, 1.5, false],
  ['us.anthropic.claude-fable-5-1-v1:0', true, true, 1, false],
  ['anthropic/claude-opus-5-5', false, false, 1, false],
  ['anthropic/claude-sonnet-5-5', false, false, 1, false],
  ['anthropic/claude-opus-4-7', false, false, 1, true],
  ['claude-3-opus-20240229', false, false, 1, true],
  ['claude-3-5-sonnet-latest', false, false, 1, true],
  ['claude-3-5-haiku-20241022', false, false, 1, true],
  ['claude-3-7-sonnet-20250219', false, false, 1, true],
  ['claude-3-haiku-20240307', false, false, 1, true],
  ['anthropic.claude-3-haiku-20240307-v1:0', false, false, 1, true],
  ['anthropic.claude-v2:1', false, false, 1, true],
  ['claude-2.1', false, false, 1, true],
  ['claude-instant-1.2', false, false, 1, true],
  ['claude-opus-4-1', false, false, 1, true],
  ['claude-opus-4-20250514', false, false, 1, true],
  ['claude-sonnet-4-20250514', false, false, 1, true],
  ['us.anthropic.claude-opus-4-20250514-v1:0', false, false, 1, true],
  ['claude-opus-4-1-20250805', false, false, 1, true],
  ['claude-opus-4', false, false, 1, true],
  ['claude-sonnet-4', false, false, 1, true],
  ['claude-opus-4-10', false, false, 1.5, true],
  ['claude-opus-3-10', false, false, 1, true],
  ['claude-opus-5-50', false, false, 1.5, true],
  ['claude-opus-6', false, false, 1.5, true],
  ['claude-opus-6-1', false, false, 1.5, true],
  ['claude-nova-5', false, false, 1, true],
  ['claude-mythos-preview', false, false, 1, true],
  ['claude-opus-4-7-preview', true, false, 1.5, true],
  ['claude-opus-4-7:0', true, false, 1.5, true],
  ['gpt-4o', false, false, 1, true],
  ['gemini-2.5-pro', false, false, 1, true],
  ['', false, false, 1, true],
  ['CLAUDE-OPUS-4-7', false, false, 1, true],
  ['claude-opus-', false, false, 1, true],
  ['claude-opus-4-7x', false, false, 1, true],
  ['xclaude-opus-4-7', false, false, 1, true],
];

// Ids the old parsers answered differently from each other; the shared parser now decides all four consumers.
// The trailing comment is the pre-merge answer. The multiplier previously ignored `[1m]` and `@date` (so a
// 4.7 id read 1x while tool search read true), accepted any dotted prefix and unreviewed suffixes, and the
// forced-tool-choice check read a patch version of a no-forced-choice model as that model.
const MERGED_PARSER_TABLE: Array<[string, boolean, boolean, number, boolean]> = [
  ['claude-opus-4-7[1m]', true, false, 1.5, true], // was true, false, 1, true
  ['claude-opus-4-7@20260101', true, false, 1.5, true], // was true, false, 1, true
  ['vendor.claude-sonnet-5-5', false, false, 1, true], // was false, false, 1.5, false
  ['foo.claude-opus-4-7', false, false, 1, true], // was false, false, 1.5, true
  ['claude-opus-5-5-1', false, false, 1, true], // was false, false, 1.5, false
  ['claude-opus-4-7-1', false, false, 1, true], // was false, false, 1.5, true
  ['claude-sonnet-4-5-2025', false, false, 1, true], // was false, false, 1.09, true
  ['claude-opus-4-7-', false, false, 1, true], // was false, false, 1.5, true
];

describe('Claude id consumers agree on real id shapes', () => {
  it.each([...CONSUMER_TABLE, ...MERGED_PARSER_TABLE])(
    '%s',
    (id, toolSearch, toolChanges, multiplier, forcedToolChoice) => {
      const backend = id.includes('anthropic.') ? ModelBackend.Bedrock : ModelBackend.Anthropic;

      expect([
        supportsToolSearch({ id, backend }),
        supportsToolChanges({ id, backend }),
        tokenEstimateMultiplier(id),
        supportsForcedToolChoice(id),
      ]).toEqual([toolSearch, toolChanges, multiplier, forcedToolChoice]);
    }
  );
});
