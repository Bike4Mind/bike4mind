import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAtlassianConfig } from '../config';

describe('getAtlassianConfig', () => {
  beforeEach(() => {
    vi.stubEnv('ATLASSIAN_ACCESS_TOKEN', 'test-token-123');
    vi.stubEnv('ATLASSIAN_CLOUD_ID', 'cloud-abc');
    vi.stubEnv('ATLASSIAN_SITE_URL', 'https://mysite.atlassian.net');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should include /wiki/ in Confluence v1 API base URL', () => {
    const config = getAtlassianConfig();
    expect(config.confluence.apiBaseUrlV1).toBe('https://api.atlassian.com/ex/confluence/cloud-abc/wiki/rest/api');
  });

  it('should include /wiki/ in Confluence v2 API base URL', () => {
    const config = getAtlassianConfig();
    expect(config.confluence.apiBaseUrlV2).toBe('https://api.atlassian.com/ex/confluence/cloud-abc/wiki/api/v2');
  });

  it('should construct correct Jira API base URL', () => {
    const config = getAtlassianConfig();
    expect(config.jira.apiBaseUrl).toBe('https://api.atlassian.com/ex/jira/cloud-abc/rest/api/3');
  });

  it('should construct correct Jira Agile API base URL', () => {
    const config = getAtlassianConfig();
    expect(config.jira.agileApiBaseUrl).toBe('https://api.atlassian.com/ex/jira/cloud-abc/rest/agile/1.0');
  });

  it('should set Bearer auth header', () => {
    const config = getAtlassianConfig();
    expect(config.confluence.authHeader).toBe('Bearer test-token-123');
    expect(config.jira.authHeader).toBe('Bearer test-token-123');
  });

  it('should append /wiki to Confluence site URL', () => {
    const config = getAtlassianConfig();
    expect(config.confluence.siteUrl).toBe('https://mysite.atlassian.net/wiki');
    expect(config.confluence.webBaseUrl).toBe('https://mysite.atlassian.net/wiki');
  });

  it('should not double-append /wiki if site URL already ends with /wiki', () => {
    vi.stubEnv('ATLASSIAN_SITE_URL', 'https://mysite.atlassian.net/wiki');
    const config = getAtlassianConfig();
    expect(config.confluence.siteUrl).toBe('https://mysite.atlassian.net/wiki');
  });

  it('should strip trailing slash from site URL', () => {
    vi.stubEnv('ATLASSIAN_SITE_URL', 'https://mysite.atlassian.net/');
    const config = getAtlassianConfig();
    expect(config.confluence.siteUrl).toBe('https://mysite.atlassian.net/wiki');
    expect(config.jira.webBaseUrl).toBe('https://mysite.atlassian.net/jira');
  });

  it('should throw when required env vars are missing', () => {
    vi.stubEnv('ATLASSIAN_ACCESS_TOKEN', '');
    vi.stubEnv('ATLASSIAN_CLOUD_ID', '');
    vi.stubEnv('ATLASSIAN_SITE_URL', '');

    expect(() => getAtlassianConfig()).toThrow('Missing required environment variables');
  });

  it('should throw listing all missing env vars', () => {
    vi.stubEnv('ATLASSIAN_ACCESS_TOKEN', '');
    vi.stubEnv('ATLASSIAN_CLOUD_ID', '');
    vi.stubEnv('ATLASSIAN_SITE_URL', '');

    expect(() => getAtlassianConfig()).toThrow('ATLASSIAN_ACCESS_TOKEN');
    expect(() => getAtlassianConfig()).toThrow('ATLASSIAN_CLOUD_ID');
    expect(() => getAtlassianConfig()).toThrow('ATLASSIAN_SITE_URL');
  });
});
