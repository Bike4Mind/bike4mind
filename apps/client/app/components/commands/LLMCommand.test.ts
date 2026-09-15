import { describe, it, expect } from 'vitest';
import { parseLLMSpec } from './LLMCommand';

describe('parseLLMSpec', () => {
  it('strips a single [Context:fileName] marker from the user prompt', () => {
    const { userPrompt } = parseLLMSpec('[Context:foo.txt] hello world');
    expect(userPrompt).toBe('hello world');
  });

  it('strips multiple [Context:fileName] markers from the user prompt', () => {
    const { userPrompt } = parseLLMSpec('[Context:a.txt] [Context:b.txt] hello');
    expect(userPrompt).toBe('hello');
  });

  it('leaves [[fileName]] paste references in the prompt (not the same marker syntax)', () => {
    const { userPrompt } = parseLLMSpec('[Context:foo.txt] tell me about [[foo.txt]]');
    expect(userPrompt).toBe('tell me about [[foo.txt]]');
  });

  it('extracts [History:N] as a number', () => {
    expect(parseLLMSpec('[History:7] hello').historyCount).toBe(7);
    expect(parseLLMSpec('[History:1] hello').historyCount).toBe(1);
  });

  it('defaults historyCount to 1 when no [History:N] marker is present', () => {
    expect(parseLLMSpec('hello').historyCount).toBe(1);
  });

  it('combines context stripping and history extraction', () => {
    const result = parseLLMSpec('[Context:foo.txt] [History:5] hi');
    expect(result.historyCount).toBe(5);
    expect(result.userPrompt).toBe('hi');
  });
});
