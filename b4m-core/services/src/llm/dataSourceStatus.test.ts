import { describe, it, expect } from 'vitest';
import { hasURLs } from '@bike4mind/fab-pipeline';
import {
  GATHERING_DATA_SOURCES_STATUS,
  PREPARING_CONTEXT_STATUS,
  resolveDataSourceStatus,
  turnGathersDataSources,
} from './dataSourceStatus';

describe('turnGathersDataSources', () => {
  it('is false for a source-free turn', () => {
    expect(turnGathersDataSources({ message: 'Hello' })).toBe(false);
    expect(
      turnGathersDataSources({ message: 'Hello', sessionFabFileIds: [], messageFileIds: [], knowledgeIds: [] })
    ).toBe(false);
  });

  it('is true for each kind of attached source', () => {
    expect(turnGathersDataSources({ message: 'Hello', sessionFabFileIds: ['file-a'] })).toBe(true);
    expect(turnGathersDataSources({ message: 'Hello', messageFileIds: ['file-a'] })).toBe(true);
    expect(turnGathersDataSources({ message: 'Hello', knowledgeIds: ['knowledge-a'] })).toBe(true);
    expect(turnGathersDataSources({ message: 'Hello', forceKnowledgeRetrieval: true })).toBe(true);
    expect(turnGathersDataSources({ message: 'See https://example.com/page for context' })).toBe(true);
  });

  // URL_REGEX is /g, so implementing this with hasURLs' .test() would leave lastIndex advanced and the
  // later hasURLs guard in processUrlsFromPrompt would return false, silently skipping the fetch.
  it('leaves the shared URL regex clean for the downstream fetch guard', () => {
    const message = 'See https://example.com/page for context';
    turnGathersDataSources({ message });
    expect(hasURLs(message)).toBe(true);
  });
});

describe('resolveDataSourceStatus', () => {
  it('maps a source-free turn to neutral copy', () => {
    expect(resolveDataSourceStatus({ message: 'Hello' })).toBe(PREPARING_CONTEXT_STATUS);
    expect(resolveDataSourceStatus({ message: 'Hello' })).toBe('Preparing context...');
  });

  it('maps a turn with sources to the data-source copy', () => {
    expect(resolveDataSourceStatus({ message: 'Hello', messageFileIds: ['file-a'] })).toBe(
      GATHERING_DATA_SOURCES_STATUS
    );
    expect(resolveDataSourceStatus({ message: 'Hello', messageFileIds: ['file-a'] })).toBe('Gathering data sources...');
  });
});
