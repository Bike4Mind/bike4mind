/**
 * Tests for AgentStore model alias resolution (MODEL_ALIASES and resolveModelAlias).
 */

import { describe, it, expect } from 'vitest';
import { MODEL_ALIASES, resolveModelAlias, getAvailableModelAliases } from './AgentStore';
import { DEFAULT_AGENT_MODEL } from './types';

describe('MODEL_ALIASES', () => {
  describe('Anthropic/Claude aliases', () => {
    it('should map short aliases to full model IDs', () => {
      expect(MODEL_ALIASES['opus']).toBe('claude-opus-4-8');
      expect(MODEL_ALIASES['sonnet']).toBe('claude-sonnet-4-5-20250929');
      expect(MODEL_ALIASES['haiku']).toBe('claude-haiku-4-5-20251001');
    });

    it('should map claude-prefixed aliases', () => {
      expect(MODEL_ALIASES['claude-opus']).toBe('claude-opus-4-8');
      expect(MODEL_ALIASES['claude-sonnet']).toBe('claude-sonnet-4-5-20250929');
      expect(MODEL_ALIASES['claude-haiku']).toBe('claude-haiku-4-5-20251001');
    });

    it('should map version-specific Claude aliases', () => {
      expect(MODEL_ALIASES['claude-4.5-opus']).toBe('claude-opus-4-5-20251101');
      expect(MODEL_ALIASES['claude-3.5-sonnet']).toBe('claude-sonnet-4-5-20250929');
      expect(MODEL_ALIASES['claude-4.8-opus']).toBe('claude-opus-4-8');
      expect(MODEL_ALIASES['claude-3-opus']).toBe('claude-opus-4-8');
    });
  });

  describe('OpenAI aliases', () => {
    it('should map GPT-4 family aliases', () => {
      expect(MODEL_ALIASES['gpt-4']).toBe('gpt-4');
      expect(MODEL_ALIASES['gpt-4o']).toBe('gpt-4o');
      expect(MODEL_ALIASES['gpt-4o-mini']).toBe('gpt-4o-mini');
      expect(MODEL_ALIASES['gpt-4-turbo']).toBe('gpt-4-turbo');
    });

    it('should map GPT-5 family aliases', () => {
      expect(MODEL_ALIASES['gpt-5']).toBe('gpt-5');
      expect(MODEL_ALIASES['gpt-5-mini']).toBe('gpt-5-mini');
    });

    it('should map reasoning model (o-series) aliases', () => {
      expect(MODEL_ALIASES['o1']).toBe('o1-2024-12-17');
      expect(MODEL_ALIASES['o3']).toBe('o3-2025-04-16');
      expect(MODEL_ALIASES['o3-mini']).toBe('o3-mini-2025-01-31');
    });
  });

  describe('Google Gemini aliases', () => {
    it('should map short Gemini aliases', () => {
      expect(MODEL_ALIASES['gemini']).toBe('gemini-2.5-pro');
      expect(MODEL_ALIASES['gemini-pro']).toBe('gemini-2.5-pro');
      expect(MODEL_ALIASES['gemini-flash']).toBe('gemini-2.5-flash');
    });

    it('should map version-specific Gemini aliases', () => {
      expect(MODEL_ALIASES['gemini-3']).toBe('gemini-3-pro-preview');
      expect(MODEL_ALIASES['gemini-2.5-pro']).toBe('gemini-2.5-pro');
      expect(MODEL_ALIASES['gemini-1.5-pro']).toBe('gemini-1.5-pro');
    });
  });

  describe('xAI Grok aliases', () => {
    it('should map Grok aliases', () => {
      expect(MODEL_ALIASES['grok']).toBe('grok-3');
      expect(MODEL_ALIASES['grok-3']).toBe('grok-3');
      expect(MODEL_ALIASES['grok-2']).toBe('grok-2-1212');
    });
  });

  describe('Other model aliases', () => {
    it('should map DeepSeek aliases', () => {
      expect(MODEL_ALIASES['deepseek']).toBe('deepseek-r1:latest');
      expect(MODEL_ALIASES['deepseek-r1']).toBe('deepseek-r1:latest');
    });

    it('should map Llama aliases', () => {
      expect(MODEL_ALIASES['llama']).toBe('llama3.3');
      expect(MODEL_ALIASES['llama3']).toBe('llama3.3');
    });
  });
});

describe('resolveModelAlias', () => {
  const testAgent = 'test-agent';
  const testPath = '/path/to/test-agent.md';

  describe('alias resolution', () => {
    it('should resolve known aliases to full model IDs', () => {
      expect(resolveModelAlias('opus', testAgent, testPath).model).toBe('claude-opus-4-8');
      expect(resolveModelAlias('sonnet', testAgent, testPath).model).toBe('claude-sonnet-4-5-20250929');
      expect(resolveModelAlias('haiku', testAgent, testPath).model).toBe('claude-haiku-4-5-20251001');
    });

    it('should mark known aliases as resolved', () => {
      expect(resolveModelAlias('opus', testAgent, testPath).resolved).toBe(true);
      expect(resolveModelAlias('sonnet', testAgent, testPath).resolved).toBe(true);
      expect(resolveModelAlias('haiku', testAgent, testPath).resolved).toBe(true);
    });

    it('should not include warning for known aliases', () => {
      expect(resolveModelAlias('opus', testAgent, testPath).warning).toBeUndefined();
    });

    it('should be case-insensitive for aliases', () => {
      expect(resolveModelAlias('OPUS', testAgent, testPath).model).toBe('claude-opus-4-8');
      expect(resolveModelAlias('Sonnet', testAgent, testPath).model).toBe('claude-sonnet-4-5-20250929');
      expect(resolveModelAlias('HaIkU', testAgent, testPath).model).toBe('claude-haiku-4-5-20251001');
    });

    it('should resolve OpenAI aliases', () => {
      expect(resolveModelAlias('gpt-4o', testAgent, testPath).model).toBe('gpt-4o');
      expect(resolveModelAlias('o3', testAgent, testPath).model).toBe('o3-2025-04-16');
    });

    it('should resolve Gemini aliases', () => {
      expect(resolveModelAlias('gemini', testAgent, testPath).model).toBe('gemini-2.5-pro');
      expect(resolveModelAlias('gemini-flash', testAgent, testPath).model).toBe('gemini-2.5-flash');
    });
  });

  describe('full model ID passthrough', () => {
    it('should pass through full Claude model IDs', () => {
      expect(resolveModelAlias('claude-opus-4-5-20251101', testAgent, testPath).model).toBe('claude-opus-4-5-20251101');
      expect(resolveModelAlias('claude-3-5-sonnet-20241022', testAgent, testPath).model).toBe(
        'claude-3-5-sonnet-20241022'
      );
    });

    it('should mark full model IDs as resolved', () => {
      expect(resolveModelAlias('claude-opus-4-5-20251101', testAgent, testPath).resolved).toBe(true);
    });

    it('should pass through full GPT model IDs', () => {
      expect(resolveModelAlias('gpt-4-turbo', testAgent, testPath).model).toBe('gpt-4-turbo');
      expect(resolveModelAlias('gpt-4.1-2025-04-14', testAgent, testPath).model).toBe('gpt-4.1-2025-04-14');
    });

    it('should pass through Bedrock model IDs', () => {
      expect(resolveModelAlias('us.anthropic.claude-3-5-haiku-20241022-v1:0', testAgent, testPath).model).toBe(
        'us.anthropic.claude-3-5-haiku-20241022-v1:0'
      );
      expect(resolveModelAlias('anthropic.claude-3-haiku-20240307-v1:0', testAgent, testPath).model).toBe(
        'anthropic.claude-3-haiku-20240307-v1:0'
      );
    });

    it('should pass through full Gemini model IDs', () => {
      expect(resolveModelAlias('gemini-2.5-pro', testAgent, testPath).model).toBe('gemini-2.5-pro');
      expect(resolveModelAlias('gemini-1.5-flash-8b', testAgent, testPath).model).toBe('gemini-1.5-flash-8b');
    });
  });

  describe('fallback behavior for unknown models', () => {
    it('should return default model for unknown alias', () => {
      const result = resolveModelAlias('unknown-model', testAgent, testPath);
      expect(result.model).toBe(DEFAULT_AGENT_MODEL);
    });

    it('should mark unknown aliases as not resolved', () => {
      const result = resolveModelAlias('unknown-model', testAgent, testPath);
      expect(result.resolved).toBe(false);
    });

    it('should include warning message for unknown alias', () => {
      const result = resolveModelAlias('unknown-model', testAgent, testPath);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('Unknown model "unknown-model"');
    });

    it('should include agent name in warning message', () => {
      const result = resolveModelAlias('foo', 'my-agent', '/path/to/my-agent.md');
      expect(result.warning).toContain('my-agent');
    });

    it('should include file path in warning message', () => {
      const result = resolveModelAlias('foo', testAgent, '/custom/path.md');
      expect(result.warning).toContain('/custom/path.md');
    });

    it('should mention using inherited model in warning', () => {
      const result = resolveModelAlias('invalid', testAgent, testPath);
      expect(result.warning).toContain('Will inherit the main session model at runtime');
    });

    it('should suggest similar aliases when available', () => {
      const result = resolveModelAlias('opuss', testAgent, testPath); // typo
      expect(result.warning).toContain('Did you mean');
      expect(result.warning).toContain('opus');
    });
  });
});

describe('getAvailableModelAliases', () => {
  it('should return sorted list of all aliases', () => {
    const aliases = getAvailableModelAliases();

    expect(aliases).toContain('opus');
    expect(aliases).toContain('sonnet');
    expect(aliases).toContain('haiku');
    expect(aliases).toContain('gpt-4o');
    expect(aliases).toContain('gemini');

    // Verify sorted
    const sorted = [...aliases].sort();
    expect(aliases).toEqual(sorted);
  });

  it('should return all keys from MODEL_ALIASES', () => {
    const aliases = getAvailableModelAliases();
    const keys = Object.keys(MODEL_ALIASES);

    expect(aliases.length).toBe(keys.length);
    for (const key of keys) {
      expect(aliases).toContain(key);
    }
  });
});
