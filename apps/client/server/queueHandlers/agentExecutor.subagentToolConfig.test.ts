import { describe, it, expect } from 'vitest';
import type { ApiKeyTable } from '@bike4mind/llm-adapters';
import { buildSubagentToolConfig } from './agentExecutor.subagentToolConfig';

describe('buildSubagentToolConfig', () => {
  it('threads the user-selected model and apiKeyTable into deep_research config', () => {
    const apiKeyTable: ApiKeyTable = { openai: 'sk-user', anthropic: 'sk-ant-user' } as ApiKeyTable;
    const result = buildSubagentToolConfig({
      model: 'claude-sonnet-4-6',
      apiKeyTable,
    });
    expect(result.deep_research).toEqual({
      model: 'claude-sonnet-4-6',
      apiKeys: apiKeyTable,
    });
    expect(result.image_generation).toBeUndefined();
    expect(result.edit_image).toBeUndefined();
  });

  it('passes undefined fields through (deep_research falls back to its built-in defaults)', () => {
    const result = buildSubagentToolConfig({});
    expect(result.deep_research).toEqual({ model: undefined, apiKeys: undefined });
    expect(result.image_generation).toBeUndefined();
    expect(result.edit_image).toBeUndefined();
  });

  it('spreads imageConfig into both image_generation and edit_image when provided (#agent-mode-image-gen)', () => {
    const imageConfig = { model: 'flux-pro-1.1-ultra', size: '1024x1024' } as const;
    const result = buildSubagentToolConfig({ model: 'claude-sonnet-4-6', imageConfig });
    expect(result.image_generation).toEqual(imageConfig);
    expect(result.edit_image).toEqual(imageConfig);
    // deep_research is still wired independently of the image config.
    expect(result.deep_research).toEqual({ model: 'claude-sonnet-4-6', apiKeys: undefined });
  });

  it('omits image tool config when imageConfig is undefined so a text-only run stays lean', () => {
    const result = buildSubagentToolConfig({ model: 'claude-sonnet-4-6', imageConfig: undefined });
    expect(result.image_generation).toBeUndefined();
    expect(result.edit_image).toBeUndefined();
  });

  it('spreads audioConfig into audio_generation when provided so agent-mode audio honors the Audio tab', () => {
    const audioConfig = { ttsProvider: 'elevenlabs', voice: 'Rachel', format: 'mp3' } as const;
    const result = buildSubagentToolConfig({ model: 'claude-sonnet-4-6', audioConfig });
    expect(result.audio_generation).toEqual(audioConfig);
    // Independent of the image config, which stays absent here.
    expect(result.image_generation).toBeUndefined();
  });

  it('omits audio_generation when audioConfig is undefined so the tool uses its built-in defaults', () => {
    const result = buildSubagentToolConfig({ model: 'claude-sonnet-4-6', audioConfig: undefined });
    expect(result.audio_generation).toBeUndefined();
  });
});
