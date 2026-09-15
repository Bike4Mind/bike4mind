import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig } from '../config.js';

describe('Notion MCP Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, NOTION_ACCESS_TOKEN: 'test-token' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw when NOTION_ACCESS_TOKEN is missing', () => {
    delete process.env.NOTION_ACCESS_TOKEN;
    expect(() => getConfig()).toThrow('NOTION_ACCESS_TOKEN is required');
  });

  it('should return default values when optional env vars are not set', () => {
    const config = getConfig();
    expect(config.accessMode).toBe('all');
    expect(config.allowedPages).toEqual([]);
    expect(config.excludedPageIds).toEqual([]);
    expect(config.writeEnabled).toBe(false);
    expect(config.rootPageId).toBeNull();
  });

  it('should parse NOTION_ALLOWED_PAGES as JSON array', () => {
    process.env.NOTION_ALLOWED_PAGES = JSON.stringify([{ id: 'abc', access: 'read' }]);
    const config = getConfig();
    expect(config.allowedPages).toEqual([{ id: 'abc', access: 'read' }]);
  });

  it('should throw on corrupt NOTION_ALLOWED_PAGES (invalid JSON)', () => {
    process.env.NOTION_ALLOWED_PAGES = 'not-valid-json{{{';
    expect(() => getConfig()).toThrow('Invalid NOTION_ALLOWED_PAGES configuration');
  });

  it('should throw when NOTION_ALLOWED_PAGES is not an array', () => {
    process.env.NOTION_ALLOWED_PAGES = JSON.stringify({ id: 'abc' });
    expect(() => getConfig()).toThrow('NOTION_ALLOWED_PAGES must be a JSON array');
  });

  it('should parse NOTION_EXCLUDED_PAGE_IDS as comma-separated list', () => {
    process.env.NOTION_EXCLUDED_PAGE_IDS = 'id1,id2,id3';
    const config = getConfig();
    expect(config.excludedPageIds).toEqual(['id1', 'id2', 'id3']);
  });

  it('should handle empty NOTION_EXCLUDED_PAGE_IDS', () => {
    process.env.NOTION_EXCLUDED_PAGE_IDS = '';
    const config = getConfig();
    expect(config.excludedPageIds).toEqual([]);
  });

  it('should parse accessMode from env var', () => {
    process.env.NOTION_ACCESS_MODE = 'selected';
    const config = getConfig();
    expect(config.accessMode).toBe('selected');
  });
});
