import { describe, expect, it } from 'vitest';
import { CliCompletionRequestAction } from './actions';

const request = (tools: unknown[]) => ({
  action: 'cli_completion_request',
  accessToken: 'token',
  requestId: '6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f',
  model: 'claude-sonnet',
  messages: [{ role: 'user', content: 'hi' }],
  options: { tools },
});

describe('CliCompletionRequestAction options.tools', () => {
  it.each([
    ['null', [null]],
    ['an empty object', [{}]],
  ])('rejects a tools entry that is %s', (_label, tools) => {
    expect(CliCompletionRequestAction.safeParse(request(tools)).success).toBe(false);
  });

  it('accepts a caller-defined tool and a tool search server tool', () => {
    const tools = [
      {
        toolSchema: { name: 'get_weather', description: 'Weather.', parameters: { type: 'object', properties: {} } },
      },
      { serverTool: { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' } },
    ];
    expect(CliCompletionRequestAction.parse(request(tools)).options?.tools).toEqual(tools);
  });
});

describe('CliCompletionRequestAction messages', () => {
  it('rejects an empty messages array', () => {
    expect(CliCompletionRequestAction.safeParse({ ...request([]), messages: [] }).success).toBe(false);
  });
});
