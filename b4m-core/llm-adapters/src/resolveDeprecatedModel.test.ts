import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveDeprecatedModelId } from './resolveDeprecatedModel';

describe('resolveDeprecatedModelId', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve deprecated Bedrock model IDs', () => {
    expect(resolveDeprecatedModelId('anthropic.claude-3-5-sonnet-20240620-v1:0')).toBe(
      'global.anthropic.claude-sonnet-4-6'
    );
    expect(resolveDeprecatedModelId('us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(
      'global.anthropic.claude-sonnet-4-6'
    );
    expect(resolveDeprecatedModelId('us.anthropic.claude-3-7-sonnet-20250219-v1:0')).toBe(
      'global.anthropic.claude-sonnet-4-6'
    );
    expect(resolveDeprecatedModelId('anthropic.claude-3-haiku-20240307-v1:0')).toBe(
      'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    );
    expect(resolveDeprecatedModelId('anthropic.claude-3-opus-20240229-v1:0')).toBe('global.anthropic.claude-opus-4-8');
  });

  it('should resolve deprecated Anthropic-hosted model IDs', () => {
    expect(resolveDeprecatedModelId('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-4-6');
    expect(resolveDeprecatedModelId('claude-3-7-sonnet-20250219')).toBe('claude-sonnet-4-6');
    expect(resolveDeprecatedModelId('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-6');
    expect(resolveDeprecatedModelId('claude-3-opus-20240229')).toBe('claude-opus-4-8');
    expect(resolveDeprecatedModelId('claude-3-haiku-20240307')).toBe('claude-haiku-4-5-20251001');
  });

  it('should pass through unknown model IDs unchanged', () => {
    expect(resolveDeprecatedModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(resolveDeprecatedModelId('gpt-4o')).toBe('gpt-4o');
    expect(resolveDeprecatedModelId('some-future-model')).toBe('some-future-model');
  });

  it('should log a warning when resolving a deprecated model', () => {
    resolveDeprecatedModelId('claude-3-5-sonnet-20241022', 'test-context');

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[model-sunset]'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('test-context'));
  });

  it('should not log a warning for non-deprecated models', () => {
    resolveDeprecatedModelId('claude-sonnet-4-6');

    expect(console.warn).not.toHaveBeenCalled();
  });
});
