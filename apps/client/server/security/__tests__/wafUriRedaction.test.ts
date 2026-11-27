import { describe, expect, it } from 'vitest';
import { redactTokenPath } from '../../middlewares/requestLogUrl';
import { maskWafRequestLine, maskWafRequestUri } from '../wafUriRedaction';

const SEGMENT = 'ab12cd34ef56ab12cd34ef56ab12cd34';

describe('maskWafRequestUri', () => {
  it.each([
    `/api/webhooks/github/${SEGMENT}`,
    `/api/webhooks/jira/${SEGMENT}`,
    `/api/file-links/${SEGMENT}`,
    `/api/email/track/open/${SEGMENT}`,
    `/api/email/track/click/${SEGMENT}`,
    `/api/publish/serve/a/${SEGMENT}/index.html`,
    `/api/admin/qa/report/run-1/${SEGMENT}/index.html`,
  ])('serves %s as the request logs do', uri => {
    const masked = maskWafRequestUri(uri);

    expect(masked).toBe(redactTokenPath(uri));
    expect(masked).not.toContain(SEGMENT);
  });

  it.each([
    '/api/chat',
    '/api/webhooks/github',
    '/api/webhooks/github/lake',
    '/api/webhooks/github/sre',
    '/api/webhooks/jira/config',
    '/api/webhooks/deliveries/66f0c0ffee0123456789abcd/retry',
    '',
  ])('leaves %s unchanged', uri => {
    expect(maskWafRequestUri(uri)).toBe(uri);
  });
});

describe('maskWafRequestLine', () => {
  it('keeps the path and the query string as separate fields', () => {
    expect(maskWafRequestLine('/api/chat', 'page=2&sort=asc')).toEqual({ uri: '/api/chat', args: 'page=2&sort=asc' });
  });

  it('returns empty args when the record has none', () => {
    expect(maskWafRequestLine(`/api/webhooks/github/${SEGMENT}`, '')).toEqual({
      uri: redactTokenPath(`/api/webhooks/github/${SEGMENT}`),
      args: '',
    });
  });

  it('keeps the name of a token query parameter and withholds its value', () => {
    const { uri, args } = maskWafRequestLine('/api/files', `page=2&shareToken=${SEGMENT}`);

    expect(uri).toBe('/api/files');
    expect(args).toContain('page=2');
    expect(args).toContain('shareToken=');
    expect(args).not.toContain(SEGMENT);
  });

  it('serves an identifier search without its query', () => {
    expect(maskWafRequestLine('/api/admin/search', 'q=someone%40example.com')).toEqual({
      uri: '/api/admin/search',
      args: '',
    });
  });
});
