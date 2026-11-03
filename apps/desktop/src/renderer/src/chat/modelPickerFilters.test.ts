// @vitest-environment jsdom
import type { ChatModelOption } from '@shared/chat';
import { LOCAL_SERVER_ID } from '@shared/modelServers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  changeFilters,
  effectiveFilters,
  filterOptions,
  matchesFilters,
  matchesQuery,
  needsHostedSwitchConfirm,
  NO_FILTERS,
  readModelPickerFilters,
  writeModelPickerFilters,
} from './modelPickerFilters';

const gpu = { id: 'abc123', name: 'gpu box' };
const haiku: ChatModelOption = { id: 'claude-haiku', name: 'Claude Haiku 5.5', backend: 'anthropic' };
const bedrockHaiku: ChatModelOption = { id: 'bedrock-haiku', name: 'Claude Haiku 5.5', backend: 'bedrock' };
const qwen: ChatModelOption = { id: 'local:ollama:qwen3:8b', name: 'qwen3:8b', backend: 'local-ollama' };
const llama: ChatModelOption = {
  id: 'local:srv-abc123:llama3',
  name: 'llama3',
  backend: 'local-srv-abc123',
  server: gpu,
};
const models = [haiku, bedrockHaiku, qwen, llama];

afterEach(() => window.localStorage.clear());

describe('filterOptions', () => {
  it('lists hosted providers and every server, this computer first, saved ones even without chat models', () => {
    expect(filterOptions(models, [{ id: 'mcsv', name: 'mcsv' }, gpu])).toEqual({
      providers: ['anthropic', 'bedrock'],
      servers: [{ id: LOCAL_SERVER_ID, name: 'This computer' }, { id: 'mcsv', name: 'mcsv' }, gpu],
      hasHosted: true,
      hasLocal: true,
    });
  });

  it('never offers a local runtime as a provider', () => {
    expect(filterOptions([qwen, llama]).providers).toEqual([]);
  });
});

describe('matchesFilters', () => {
  const pick = (filters: Partial<typeof NO_FILTERS>) =>
    models.filter(model => matchesFilters(model, { ...NO_FILTERS, ...filters })).map(model => model.id);

  it('narrows by location, provider and server', () => {
    expect(pick({})).toEqual(models.map(model => model.id));
    expect(pick({ location: 'hosted' })).toEqual(['claude-haiku', 'bedrock-haiku']);
    expect(pick({ location: 'local' })).toEqual([qwen.id, llama.id]);
    expect(pick({ provider: 'bedrock' })).toEqual(['bedrock-haiku']);
    expect(pick({ server: LOCAL_SERVER_ID })).toEqual([qwen.id]);
    expect(pick({ server: 'abc123' })).toEqual([llama.id]);
  });
});

describe('changeFilters', () => {
  it('clears the side a choice rules out', () => {
    expect(changeFilters({ ...NO_FILTERS, server: 'abc123' }, { provider: 'anthropic' })).toEqual({
      location: 'all',
      provider: 'anthropic',
      server: null,
    });
    expect(changeFilters({ ...NO_FILTERS, provider: 'anthropic' }, { location: 'local' })).toEqual({
      location: 'local',
      provider: null,
      server: null,
    });
    expect(changeFilters({ ...NO_FILTERS, server: 'abc123' }, { location: 'hosted' }).server).toBeNull();
  });
});

describe('effectiveFilters', () => {
  it('drops a provider or server this list no longer offers', () => {
    const options = filterOptions(models);
    expect(effectiveFilters({ location: 'all', provider: 'gone', server: null }, options).provider).toBeNull();
    expect(effectiveFilters({ location: 'local', provider: null, server: 'gone' }, options)).toEqual({
      location: 'local',
      provider: null,
      server: null,
    });
    expect(effectiveFilters({ location: 'all', provider: 'bedrock', server: null }, options).provider).toBe('bedrock');
  });

  it('leaves the filters alone while the list is empty', () => {
    const filters = { location: 'local' as const, provider: null, server: 'abc123' };
    expect(effectiveFilters(filters, filterOptions([]))).toBe(filters);
  });
});

describe('matchesQuery', () => {
  it.each([
    [haiku, 'haiku', true],
    [haiku, 'anthropic', true],
    [haiku, 'hosted', true],
    [haiku, 'local', false],
    [haiku, 'haiku bed', false],
    [bedrockHaiku, 'haiku bed', true],
    [qwen, 'local', true],
    [qwen, 'this computer', true],
    [qwen, 'hosted', false],
    [llama, 'gpu', true],
    [llama, 'llama gpu', true],
    [llama, 'srv-abc', false],
    [haiku, 'claude-haiku', false],
  ])('%#: %o matches %s: %s', (model, query, expected) => {
    expect(matchesQuery(model, query)).toBe(expected);
  });

  it('matches the visible detail as a phrase', () => {
    expect(matchesQuery(haiku, '2025-04', 'anthropic - claude-haiku-2025-04')).toBe(true);
  });
});

describe('needsHostedSwitchConfirm', () => {
  it('asks only when a local conversation with messages moves to a hosted model', () => {
    expect(needsHostedSwitchConfirm(qwen.id, haiku, true)).toBe(true);
    expect(needsHostedSwitchConfirm(llama.id, haiku, true)).toBe(true);
    expect(needsHostedSwitchConfirm(qwen.id, haiku, false)).toBe(false);
    expect(needsHostedSwitchConfirm(qwen.id, llama, true)).toBe(false);
    expect(needsHostedSwitchConfirm(haiku.id, bedrockHaiku, true)).toBe(false);
    expect(needsHostedSwitchConfirm(null, haiku, true)).toBe(false);
    expect(needsHostedSwitchConfirm('local:', haiku, true)).toBe(false);
  });
});

describe('stored filters', () => {
  it('round-trips and survives junk', () => {
    expect(readModelPickerFilters()).toEqual(NO_FILTERS);
    writeModelPickerFilters({ location: 'local', provider: null, server: 'abc123' });
    expect(readModelPickerFilters()).toEqual({ location: 'local', provider: null, server: 'abc123' });

    window.localStorage.setItem('b4m.modelPicker.filters', '{not json');
    expect(readModelPickerFilters()).toEqual(NO_FILTERS);
    window.localStorage.setItem('b4m.modelPicker.filters', JSON.stringify({ location: 'cloud', provider: 7 }));
    expect(readModelPickerFilters()).toEqual(NO_FILTERS);
  });
});
