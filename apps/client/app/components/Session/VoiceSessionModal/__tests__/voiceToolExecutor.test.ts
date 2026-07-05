import { describe, it, expect } from 'vitest';
import { formatToolExecution } from '../voiceToolExecutor';

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
