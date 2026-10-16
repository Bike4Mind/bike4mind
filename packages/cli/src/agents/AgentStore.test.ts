/**
 * Tests for AgentStore model alias resolution (MODEL_ALIASES and resolveModelAlias).
 */

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { ChatModels, type ModelInfo } from '@bike4mind/common';
import {
  AnthropicBackend,
  AWSBackend,
  BFLBackend,
  DEPRECATED_MODEL_MAP,
  DeepSeekBackend,
  GeminiBackend,
  KimiBackend,
  OpenAIBackend,
  UndifferentiatedBedrockBackend,
  XAIBackend,
} from '@bike4mind/llm-adapters';
import {
  MODEL_ALIASES,
  RETIRED_MODEL_ALIASES,
  SUNSETTING_MODEL_ALIASES,
  resolveModelAlias,
  getAvailableModelAliases,
} from './AgentStore';
import { DEFAULT_AGENT_MODEL } from './types';

// Ollama tags are discovered from the local daemon at runtime, so the static
// catalog cannot vouch for them.
const LOCAL_OLLAMA_TARGETS = new Set<string>([ChatModels.LLAMA3_LOCAL, ChatModels.TINYLLAMA, ChatModels.DEEPSEEK_R1]);

async function loadCatalog(): Promise<ModelInfo[]> {
  const backends = [
    new OpenAIBackend('test-key-not-used'),
    new AnthropicBackend('test-key-not-used'),
    new UndifferentiatedBedrockBackend(),
    new GeminiBackend('test-key-not-used'),
    new XAIBackend('test-key-not-used'),
    new KimiBackend('test-key-not-used'),
    new DeepSeekBackend('test-key-not-used'),
    new AWSBackend(),
    new BFLBackend('test-key-not-used'),
  ];
  return (await Promise.all(backends.map(b => b.getModelInfo()))).flat();
}

describe('MODEL_ALIASES invariants', () => {
  async function findInactive(targets: Array<[string, string]>): Promise<string[]> {
    const models = await loadCatalog();
    const active = new Set(models.filter(m => !m.deprecationDate && !m.disabled).map(m => String(m.id)));

    return targets
      .filter(([, target]) => !LOCAL_OLLAMA_TARGETS.has(target))
      .filter(([, target]) => !active.has(target) || target in DEPRECATED_MODEL_MAP)
      .map(([source, target]) => `${source} -> ${target}`);
  }

  it('every CLI alias resolves to an active catalog model', async () => {
    const bad = await findInactive(Object.entries(MODEL_ALIASES));
    expect(bad, `aliases pointing at unknown, deprecated, disabled or redirected models: ${bad.join(', ')}`).toEqual(
      []
    );
  });

  it('the default agent model and every built-in agent model are active catalog models', async () => {
    const defaultsDir = path.join(__dirname, 'defaults');
    const builtins: Array<[string, string]> = [['DEFAULT_AGENT_MODEL', DEFAULT_AGENT_MODEL]];
    for (const file of readdirSync(defaultsDir).filter(f => f.endsWith('.md'))) {
      const declared = /^model:\s*(\S+)\s*$/m.exec(readFileSync(path.join(defaultsDir, file), 'utf8'))?.[1];
      if (declared) builtins.push([file, resolveModelAlias(declared, file, file).model]);
    }
    expect(builtins.length).toBeGreaterThan(1);

    const bad = await findInactive(builtins);
    expect(bad, `built-in agents pinned to unknown or inactive models: ${bad.join(', ')}`).toEqual([]);
  });

  it('every sunsetting alias retires on its catalog deprecationDate', async () => {
    const byId = new Map((await loadCatalog()).map(m => [String(m.id), m]));
    const drift = Object.entries(SUNSETTING_MODEL_ALIASES)
      .filter(([, { model, retiresOn }]) => {
        const info = byId.get(model);
        return !info || info.disabled || info.deprecationDate !== retiresOn || model in DEPRECATED_MODEL_MAP;
      })
      .map(([alias, { model, retiresOn }]) => `${alias} -> ${model} (retiresOn ${retiresOn})`);
    expect(drift, `sunsetting aliases out of sync with the catalog: ${drift.join(', ')}`).toEqual([]);
  });

  it('alias tables are disjoint and every suggested successor is a live alias', () => {
    const sunsetting = Object.keys(SUNSETTING_MODEL_ALIASES);
    const retired = Object.keys(RETIRED_MODEL_ALIASES);
    const live = new Set(Object.keys(MODEL_ALIASES));
    expect([...sunsetting, ...retired].filter(a => live.has(a))).toEqual([]);
    expect(sunsetting.filter(a => retired.includes(a))).toEqual([]);

    const successors = [
      ...Object.values(SUNSETTING_MODEL_ALIASES).map(e => e.successor),
      ...Object.values(RETIRED_MODEL_ALIASES),
    ];
    expect(successors.filter(s => !live.has(s))).toEqual([]);
  });
});

describe('retiring and retired aliases', () => {
  const before = new Date('2026-10-22T12:00:00Z');
  const onDate = new Date('2026-10-23T00:00:00Z');

  it('a sunsetting alias resolves to its target until the retirement date', () => {
    const result = resolveModelAlias('o4-mini', 'test-agent', '/test/path.md', before);
    expect(result).toEqual({ model: 'o4-mini-2025-04-16', resolved: true });
    expect(getAvailableModelAliases(before)).toContain('o4-mini');
  });

  it('a sunsetting alias reports retired with its successor from the retirement date on', () => {
    const result = resolveModelAlias('o4-mini', 'test-agent', '/test/path.md', onDate);
    expect(result.resolved).toBe(false);
    expect(result.model).toBe(DEFAULT_AGENT_MODEL);
    expect(result.warning).toContain('"o4-mini"');
    expect(result.warning).toContain('is retired');
    expect(result.warning).toContain('model: gpt-5-mini');
    expect(getAvailableModelAliases(onDate)).not.toContain('o4-mini');
  });

  it('resolves the dated id of a still-served model until its retirement date', () => {
    expect(resolveModelAlias('o3-2025-04-16', 'test-agent', '/test/path.md', before)).toEqual({
      model: 'o3-2025-04-16',
      resolved: true,
    });
    // o3 retires on 2026-12-11, after the o4-mini cutoff, so it is still served
    // across that earlier date.
    expect(resolveModelAlias('o3-2025-04-16', 'test-agent', '/test/path.md', onDate)).toEqual({
      model: 'o3-2025-04-16',
      resolved: true,
    });
  });

  it('retires each alias on its own date, not the earliest cutoff', () => {
    const o3Retirement = new Date('2026-12-11T00:00:00Z');
    for (const input of ['o3', 'o3-2025-04-16']) {
      const result = resolveModelAlias(input, 'test-agent', '/test/path.md', o3Retirement);
      expect(result.resolved, `${input} must be retired on 2026-12-11`).toBe(false);
      expect(result.model).toBe(DEFAULT_AGENT_MODEL);
      expect(result.warning).toContain('is retired');
      expect(result.warning).toContain('model: gpt-5.5');
    }
  });

  it('warns for the dated id of a retired model instead of pinning it', () => {
    const result = resolveModelAlias('O4-MINI-2025-04-16', 'test-agent', '/test/path.md', onDate);
    expect(result.resolved).toBe(false);
    expect(result.model).toBe(DEFAULT_AGENT_MODEL);
    expect(result.warning).toContain('is retired');
    expect(result.warning).toContain('model: gpt-5-mini');
  });

  it('a retired alias names its replacement instead of pinning a dead id', () => {
    const result = resolveModelAlias('o1', 'test-agent', '/test/path.md');
    expect(result.resolved).toBe(false);
    expect(result.model).toBe(DEFAULT_AGENT_MODEL);
    expect(result.warning).toContain('is retired');
    expect(result.warning).toContain('model: gpt-5.5');
  });

  it('does not resolve prototype keys as aliases', () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      const result = resolveModelAlias(key, 'test-agent', '/test/path.md');
      expect(result.resolved, `${key} must not resolve`).toBe(false);
      expect(result.model).toBe(DEFAULT_AGENT_MODEL);
      expect(result.warning).toContain('Unknown model');
    }
  });

  it('a retired alias that looks like a full id still warns rather than passing through', () => {
    const result = resolveModelAlias('gemini-1.5-pro', 'test-agent', '/test/path.md');
    expect(result.resolved).toBe(false);
    expect(result.warning).toContain('model: gemini-pro');
  });
});

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
      expect(MODEL_ALIASES['gpt-4o']).toBe('gpt-4o');
      expect(MODEL_ALIASES['gpt-4o-mini']).toBe('gpt-4o-mini');
    });

    it('should map GPT-5 family aliases', () => {
      expect(MODEL_ALIASES['gpt-5']).toBe('gpt-5');
      expect(MODEL_ALIASES['gpt-5-mini']).toBe('gpt-5-mini');
    });

    it('keeps o-series aliases out of the live table', () => {
      expect(MODEL_ALIASES['o1']).toBeUndefined();
      expect(MODEL_ALIASES['o3']).toBeUndefined();
      expect(SUNSETTING_MODEL_ALIASES['o3'].model).toBe('o3-2025-04-16');
      expect(RETIRED_MODEL_ALIASES['o3-mini']).toBe('gpt-5-mini');
    });
  });

  describe('Google Gemini aliases', () => {
    it('should map short Gemini aliases', () => {
      expect(MODEL_ALIASES['gemini']).toBe('gemini-3.5-flash');
      expect(MODEL_ALIASES['gemini-pro']).toBe('gemini-3.1-pro-preview');
      expect(MODEL_ALIASES['gemini-flash']).toBe('gemini-3.5-flash');
    });

    it('should map version-specific Gemini aliases', () => {
      expect(MODEL_ALIASES['gemini-3']).toBe('gemini-3.1-pro-preview');
      expect(MODEL_ALIASES['gemini-2.5-pro']).toBe('gemini-3.5-flash');
      expect(MODEL_ALIASES['gemini-1.5-pro']).toBeUndefined();
    });
  });

  describe('xAI Grok aliases', () => {
    it('should map Grok aliases', () => {
      expect(MODEL_ALIASES['grok']).toBe('grok-4.5');
      expect(MODEL_ALIASES['grok-3']).toBe('grok-4.5');
      expect(MODEL_ALIASES['grok-2']).toBe('grok-4.5');
    });
  });

  describe('Other model aliases', () => {
    it('should map DeepSeek aliases', () => {
      // Bare `deepseek` names the hosted model; `deepseek-r1` stays the Ollama tag.
      expect(MODEL_ALIASES['deepseek']).toBe('deepseek-flash');
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
      expect(resolveModelAlias('gpt-4.1-2025-04-14', testAgent, testPath).model).toBe('gpt-4.1-2025-04-14');
    });

    it('should resolve Gemini aliases', () => {
      expect(resolveModelAlias('gemini', testAgent, testPath).model).toBe('gemini-3.5-flash');
      expect(resolveModelAlias('gemini-flash', testAgent, testPath).model).toBe('gemini-3.5-flash');
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
      expect(resolveModelAlias('gpt-5-chat-latest', testAgent, testPath).model).toBe('gpt-5-chat-latest');
      expect(resolveModelAlias('gpt-4.1-2025-04-14', testAgent, testPath).model).toBe('gpt-4.1-2025-04-14');
      // An undated id keeps passing through after every sunsetting date.
      const farFuture = new Date('2100-01-01T00:00:00Z');
      expect(resolveModelAlias('gpt-5-chat-latest', testAgent, testPath, farFuture).model).toBe('gpt-5-chat-latest');
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
      expect(resolveModelAlias('gemini-3.1-pro-preview', testAgent, testPath).model).toBe('gemini-3.1-pro-preview');
      expect(resolveModelAlias('gemini-3-flash-preview', testAgent, testPath).model).toBe('gemini-3-flash-preview');
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
      expect(result.warning).toContain('Will inherit the parent or main session model at runtime');
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

  it('should return all keys from MODEL_ALIASES once every sunsetting alias has retired', () => {
    const aliases = getAvailableModelAliases(new Date('2030-01-01'));
    const keys = Object.keys(MODEL_ALIASES);

    expect(aliases.length).toBe(keys.length);
    for (const key of keys) {
      expect(aliases).toContain(key);
    }
  });
});
