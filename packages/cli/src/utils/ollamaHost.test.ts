import { describe, expect, it } from 'vitest';
import { withDefaultOllamaPort } from './ollamaHost';

describe('withDefaultOllamaPort', () => {
  it.each([
    ['gpu-box', 'http://gpu-box:11434'],
    ['127.0.0.1', 'http://127.0.0.1:11434'],
    ['[::1]', 'http://[::1]:11434'],
    ['127.0.0.1:11500', 'http://127.0.0.1:11500'],
    ['[::1]:8080', 'http://[::1]:8080'],
    ['gpu-box/ollama', 'http://gpu-box:11434/ollama'],
    ['  gpu-box  ', 'http://gpu-box:11434'],
  ])('%s -> %s', (host, expected) => {
    expect(withDefaultOllamaPort(host)).toBe(expected);
  });

  it('leaves hosts with a scheme alone', () => {
    expect(withDefaultOllamaPort('http://gpu-box')).toBe('http://gpu-box');
    expect(withDefaultOllamaPort('https://ollama.example.test')).toBe('https://ollama.example.test');
  });
});
