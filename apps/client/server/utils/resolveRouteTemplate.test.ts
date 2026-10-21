import { describe, expect, it } from 'vitest';
import { resolveRequestPathname, resolveRouteTemplate } from './resolveRouteTemplate';

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

  it('does not let a repeated query key spoof a catch-all template', () => {
    expect(resolveRouteTemplate(req('/api/admin/integration-status?z=api&z=admin', { z: ['api', 'admin'] }))).toBe(
      '/api/admin/integration-status'
    );
  });

  it('keeps a static prefix when a param value repeats an earlier static segment', () => {
    expect(resolveRouteTemplate(req('/api/admin/gears/admin', { key: 'admin' }))).toBe('/api/admin/gears/[key]');
  });

  it('keeps a static prefix when catch-all values repeat earlier static segments', () => {
    expect(resolveRouteTemplate(req('/api/admin/qa/api/admin', { path: ['api', 'admin'] }))).toBe(
      '/api/admin/qa/[...path]'
    );
  });

  it('decodes percent-encoded segments when matching params', () => {
    expect(resolveRouteTemplate(req('/api/tags/a%20b', { tag: 'a b' }))).toBe('/api/tags/[tag]');
  });

  it('strips fragments and tolerates a missing query object', () => {
    expect(resolveRouteTemplate({ originalUrl: '/api/chat#x', url: '/api/chat' } as never)).toBe('/api/chat');
  });

  it.each<[string, Record<string, string | string[]>, string, string]>([
    ['/api/agents/a1?id=a1', { id: 'a1' }, '/api/agents/a1', 'unknown'],
    ['/api/agents/a%201?id=a+1', { id: 'a 1' }, '/api/agents/a%201', 'unknown'],
    ['/api/files/a/b?path=a&path=b', { path: ['a', 'b'] }, '/api/files/a/b', 'unknown'],
    ['/api/items/1?n=1', { n: '1' }, '/api/items/1', 'unknown'],
    [
      '/api/admin/integration-status?z=api&z=admin',
      { z: ['api', 'admin'] },
      '/api/admin/integration-status',
      'unknown',
    ],
    ['/api/agents/a1?id=other', { id: 'a1' }, '/api/agents/[id]', '/api/agents/[id]'],
    ['/api/agents/a1?x=1', { id: 'a1', x: '1' }, '/api/agents/[id]', '/api/agents/[id]'],
    ['/api/chat?x=', { x: '' }, '/api/chat', '/api/chat'],
    ['/api/chat', {}, '/api/chat', '/api/chat'],
  ])('optionally redacts ambiguous query/path values in %s', (url, query, normal, redacted) => {
    expect(resolveRouteTemplate(req(url, query))).toBe(normal);
    expect(resolveRouteTemplate(req(url, query), { redactAmbiguousQuery: true })).toBe(redacted);
  });
});

describe('resolveRequestPathname', () => {
  const at = (originalUrl: string) => resolveRequestPathname({ originalUrl, url: originalUrl });

  it('drops the query string and fragment', () => {
    expect(at('/api/admin/x?a=1#f')).toBe('/api/admin/x');
  });

  it('decodes percent-encoded and double-encoded segments so a prefix check sees the routed path', () => {
    expect(at('/api/%61dmin/x')).toBe('/api/admin/x');
    expect(at('/api/%2561dmin/x')).toBe('/api/admin/x');
  });

  it('collapses repeated slashes and tolerates malformed escapes', () => {
    expect(at('//api//admin/x')).toBe('/api/admin/x');
    expect(at('/api/%zz')).toBe('/api/%zz');
  });
});
