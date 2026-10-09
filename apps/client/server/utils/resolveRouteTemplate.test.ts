import { describe, expect, it } from 'vitest';
import { resolveRouteTemplate } from './resolveRouteTemplate';

const req = (originalUrl: string, query: Record<string, string | string[]> = {}) =>
  ({ originalUrl, url: originalUrl, query }) as Parameters<typeof resolveRouteTemplate>[0];

describe('resolveRouteTemplate', () => {
  it('collapses a dynamic segment and drops the query string', () => {
    expect(resolveRouteTemplate(req('/api/agents/abc?x=1', { id: 'abc', x: '1' }))).toBe('/api/agents/[id]');
  });

  it('collapses several dynamic segments', () => {
    expect(resolveRouteTemplate(req('/api/agents/abc/missions/m1', { id: 'abc', missionId: 'm1' }))).toBe(
      '/api/agents/[id]/missions/[missionId]'
    );
  });

  it('collapses catch-all params', () => {
    expect(resolveRouteTemplate(req('/api/files/a/b/c.txt', { path: ['a', 'b', 'c.txt'] }))).toBe(
      '/api/files/[...path]'
    );
  });

  it('leaves static routes untouched and strips the query string', () => {
    expect(resolveRouteTemplate(req('/api/chat?stream=true', { stream: 'true' }))).toBe('/api/chat');
  });

  it('does not let a query-string value claim a static segment', () => {
    expect(resolveRouteTemplate(req('/api/items/1?n=1', { n: '1' }))).toBe('/api/items/1');
  });

  it('still templates a catch-all whose name collides with a query key', () => {
    expect(resolveRouteTemplate(req('/a/tok123?path=1', { path: ['tok123'] }))).toBe('/a/[...path]');
  });

  it('still templates a single param whose name collides with a differing query value', () => {
    expect(resolveRouteTemplate(req('/api/agents/abc?id=zzz', { id: 'abc' }))).toBe('/api/agents/[id]');
  });

  it('decodes percent-encoded segments when matching params', () => {
    expect(resolveRouteTemplate(req('/api/tags/a%20b', { tag: 'a b' }))).toBe('/api/tags/[tag]');
  });

  it('strips fragments and tolerates a missing query object', () => {
    expect(resolveRouteTemplate({ originalUrl: '/api/chat#x', url: '/api/chat' } as never)).toBe('/api/chat');
  });
});
