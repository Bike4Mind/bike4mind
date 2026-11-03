import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: postMock } }));

import { executeVoiceTool, formatToolExecution } from '../voiceToolExecutor';

describe('formatToolExecution', () => {
  it('formats web_search with the query', () => {
    expect(formatToolExecution('web_search', { query: 'TypeScript generics' })).toBe(
      'Searching the web for "TypeScript generics"...'
    );
  });

  it('formats web_fetch with the url', () => {
    expect(formatToolExecution('web_fetch', { url: 'https://example.com/article' })).toBe(
      'Fetching content from https://example.com/article...'
    );
  });

  it('formats weather_info', () => {
    expect(formatToolExecution('weather_info', { lat: 40.71, lon: -74.01 })).toBe('Checking weather...');
  });

  it('formats current_datetime', () => {
    expect(formatToolExecution('current_datetime', {})).toBe('Getting current date and time...');
  });

  it('formats agent_request', () => {
    expect(formatToolExecution('agent_request', { message: 'search my files' })).toBe(
      'Processing with full AI system...'
    );
  });

  it('formats unknown tools with the tool name', () => {
    expect(formatToolExecution('some_future_tool', {})).toBe('Using some_future_tool...');
  });
});

describe('executeVoiceTool error reporting', () => {
  beforeEach(() => {
    postMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('surfaces the server message when the account-trust gate refuses the tool', async () => {
    const message = 'Your account is too new to use this tool.';
    const response = {
      status: 403,
      data: { error: message, errorCode: 'account_trust_required' },
    } as AxiosResponse;
    postMock.mockRejectedValue(
      new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', undefined, {}, response)
    );

    await expect(executeVoiceTool('web_search', { query: 'x' })).resolves.toEqual({ success: false, error: message });
  });

  it('keeps the plain error message for other failures', async () => {
    postMock.mockRejectedValue(new Error('boom'));

    await expect(executeVoiceTool('web_search', { query: 'x' })).resolves.toEqual({ success: false, error: 'boom' });
  });
});
