import { describe, it, expect } from 'vitest';
import { errorTitle, formatErrorLogSlackMessage, splitErrorDetail, stackFrames } from './errorLogSlackMessage';

const oktaStack = [
  'ClientError: unexpected HTTP response status code',
  '    at e (file:///var/task/node_modules/.pnpm/openid-client@6.8.8/node_modules/openid-client/build/index.js:115:12)',
  '    at errorHandler (file:///var/task/node_modules/.pnpm/openid-client@6.8.8/node_modules/openid-client/build/index.js:132:23)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
  '    at async performDiscovery (file:///var/task/node_modules/.pnpm/openid-client@6.8.8/node_modules/openid-client/build/index.js:267:16)',
  '    at async Module.discovery (file:///var/task/node_modules/.pnpm/openid-client@6.8.8/node_modules/openid-client/build/index.js:244:16)',
  '    at async O (/var/task/apps/client/.next/server/chunks/[root-of-the-server]__0e9enyjn3zh6w._.js:1:1738)',
  '    at async h (/var/task/apps/client/.next/server/chunks/[root-of-the-server]__0e9enyjn3zh6w._.js:1:3691)',
  '    at async Array.<anonymous> (/var/task/apps/client/.next/server/chunks/apps_client_pages_api_auth_okta_index_ts_0aoknwrrrs6-v._.js:1:1246)',
].join('\n');

const oktaMessage =
  '[OktaOidc] Discovery failed for custom (default) auth server at: https://trial-1234567.okta.com/oauth2/default/.well-known/openid-configuration ' +
  JSON.stringify({
    code: 'OAUTH_RESPONSE_IS_NOT_CONFORM',
    name: 'ClientError',
    message: 'unexpected HTTP response status code',
    stack: oktaStack,
  });

const metadata = {
  requestId: 'bbcf0a53-5961-49e6-a00d-c559b9b38998',
  traceId: 'Root=1-6ae09d02-686be67b2b31cdf56edfa9d7',
  method: 'GET',
  path: '/api/auth/okta',
  stage: 'production',
  clientIp: '203.0.113.9',
  severity: 'error',
  message: oktaMessage,
};

type Block = { type: string; text?: { text: string }; fields?: { text: string }[]; elements?: { text: string }[] };

const render = (overrides: Partial<Parameters<typeof formatErrorLogSlackMessage>[0]> = {}) =>
  formatErrorLogSlackMessage({
    message: oktaMessage,
    severity: 'error',
    metadata,
    stage: 'production',
    logGroup: '/aws/lambda/bike4mind-production-server',
    url: 'https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#logEventViewer:group=g;stream=s',
    count: 1,
    ...overrides,
  });

const blocksOf = (payload: ReturnType<typeof render>) => payload.attachments?.[0].blocks as Block[];

describe('formatErrorLogSlackMessage', () => {
  it('renders the OktaOidc error as a short titled card with fields, first frame and a folded stack', () => {
    const payload = render();
    expect(payload.text).toBe(
      'ERROR on production: [OktaOidc] Discovery failed for custom (default) auth server at: https://trial-1234567.okta.com/oauth2/default/.well-known/openid-configuration: ClientError: unexpected HTTP response status code'
    );
    expect(payload.attachments?.[0].color).toBe('#E01E5A');
    const blocks = blocksOf(payload);
    expect(blocks[0].text?.text).toBe(
      ':red_circle: *ERROR on production*  |  GET /api/auth/okta\n[OktaOidc] Discovery failed for custom (default) auth server at: https://trial-1234567.okta.com/oauth2/default/.well-known/openid-configuration: ClientError: unexpected HTTP response status code'
    );
    expect(blocks[1].fields?.map(f => f.text)).toEqual([
      '*Request*\nbbcf0a53-5961-49e6-a00d-c559b9b38998',
      '*Trace*\nRoot=1-6ae09d02-686be67b2b31cdf56edfa9d7',
      '*Client IP*\n203.0.113.9',
      '*Code*\nOAUTH_RESPONSE_IS_NOT_CONFORM',
      '*Log group*\nbike4mind-production-server',
    ]);
    const stack = blocks[2].text?.text ?? '';
    expect(stack.startsWith('*First frame*\n`at e (file:///var/task/node_modules/.pnpm/openid-client@6.8.8')).toBe(
      true
    );
    expect(stack).toContain('```at errorHandler');
    expect(stack).toContain('at async Module.discovery');
    expect(stack).toContain('... 1 more');
    expect(stack).not.toContain('ClientError: unexpected');
    expect(blocks[3].elements?.[0].text).toBe(
      '<https://console.aws.amazon.com/cloudwatch/home?region=us-east-2#logEventViewer:group=g;stream=s|Open in CloudWatch>  |  production'
    );
    expect(stack.length).toBeLessThan(1100);
    expect(JSON.stringify(payload).length).toBeLessThan(2400);
  });

  it('caps a very long stack and says how many frames were left out', () => {
    const frames = Array.from({ length: 30 }, (_, i) => `    at frame${i} (/var/task/file${i}.js:${i}:1)`);
    const message = `Boom ${JSON.stringify({ stack: ['Error: boom', ...frames].join('\n') })}`;
    const stack = blocksOf(render({ message }))[2].text?.text ?? '';
    expect(stack).toContain('at frame6 ');
    expect(stack).not.toContain('at frame7 ');
    expect(stack).toContain('... 23 more');
  });

  it('keeps the message and stack of an unhandled Lambda error (runtime Invoke Error line)', () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      '    at handler (/var/task/apps/workers/src/events/thing.js:12:30)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
    ];
    const line =
      '2026-10-27T00:53:48.462Z\t3377e888-1111-2222-3333-444444444444\tERROR\tInvoke Error \t' +
      JSON.stringify({
        errorType: 'TypeError',
        errorMessage: "Cannot read properties of undefined (reading 'id')",
        stack,
      });
    const payload = formatErrorLogSlackMessage({
      message: line,
      severity: 'error',
      metadata: { source: 'AWS' },
      stage: 'production',
      logGroup: '/aws/lambda/bike4mind-production-thing',
      url: 'https://example.com/log',
      count: 1,
    });
    expect(payload.text).toBe(
      "ERROR on production: Invoke Error: TypeError: Cannot read properties of undefined (reading 'id')"
    );
    const blocks = blocksOf(payload);
    expect(blocks[0].text?.text).toBe(
      ":red_circle: *ERROR on production*\nInvoke Error: TypeError: Cannot read properties of undefined (reading 'id')"
    );
    expect(blocks[1].fields?.map(f => f.text)).toEqual(['*Log group*\nbike4mind-production-thing']);
    expect(blocks[2].text?.text).toBe(
      '*First frame*\n`at handler (/var/task/apps/workers/src/events/thing.js:12:30)`\n```at process.processTicksAndRejections (node:internal/process/task_queues:104:5)```'
    );
    expect(blocks[3].type).toBe('context');
  });

  it('shows the grouped count and duration', () => {
    const fields = blocksOf(render({ count: 4, duration: '6m 0s' }))[1].fields?.map(f => f.text) ?? [];
    expect(fields).toContain('*Seen*\n4 times in 6m 0s');
  });

  it('handles a plain message with no structured detail or request fields', () => {
    const payload = formatErrorLogSlackMessage({
      message: 'Task timed out after 30.03 seconds\nsecond line',
      severity: 'error',
      metadata: { source: 'AWS' },
      stage: 'production',
      logGroup: '/aws/lambda/fn',
      url: 'https://example.com/log',
      count: 1,
    });
    const blocks = blocksOf(payload);
    expect(blocks[0].text?.text).toBe(':red_circle: *ERROR on production*\nTask timed out after 30.03 seconds');
    expect(blocks[1].fields?.map(f => f.text)).toEqual(['*Log group*\nfn']);
    expect(blocks[2].type).toBe('context');
  });

  it('uses the amber style for warnings and escapes mrkdwn control characters', () => {
    const payload = render({ severity: 'warn', message: 'Odd <thing> & co' });
    expect(payload.attachments?.[0].color).toBe('#ECB22E');
    expect(blocksOf(payload)[0].text?.text).toBe(
      ':large_yellow_circle: *WARN on production*  |  GET /api/auth/okta\nOdd &lt;thing&gt; &amp; co'
    );
  });

  it('clips a long request path and keeps every section under the Slack limit after escaping', () => {
    const path = '/api/search?q=' + '<a>&'.repeat(600);
    const payload = render({ metadata: { ...metadata, path } });
    const blocks = blocksOf(payload);
    const first = blocks[0].text?.text ?? '';
    expect(first).toContain('GET /api/search?q=&lt;a&gt;&amp;');
    expect(first).toContain('...');
    expect(first.length).toBeLessThanOrEqual(3000);
    for (const block of blocks) {
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
      for (const f of block.fields ?? []) expect(f.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('caps an escape-heavy stack section after escaping', () => {
    const frames = Array.from({ length: 10 }, (_, i) => `    at f${i} (${'<&>'.repeat(60)}:${i}:1)`);
    const message = `Boom ${JSON.stringify({ stack: ['Error: boom', ...frames].join('\n') })}`;
    const stack = blocksOf(render({ message }))[2].text?.text ?? '';
    expect(stack.length).toBeLessThanOrEqual(3000);
  });

  it('never loses the closing fence or splits an entity when an escape-heavy stack is clipped', () => {
    const frames = Array.from({ length: 10 }, (_, i) => `    at f${i} (${'<&>'.repeat(300)}:${i}:1)`);
    const message = `Boom ${JSON.stringify({ stack: ['Error: boom', ...frames].join('\n') })}`;
    const stack = blocksOf(render({ message }))[2].text?.text ?? '';
    expect(stack.length).toBeLessThanOrEqual(3000);
    expect(stack.endsWith('...```')).toBe(true);
    expect(stack).not.toMatch(/&[a-z]{0,3}\.\.\.```$/);
    expect(stack.match(/```/g)).toHaveLength(2);
  });

  it('coerces non-string metadata values instead of throwing', () => {
    const payload = render({ metadata: { ...metadata, requestId: 12345, userId: { id: 'u1' }, sessionId: null } });
    const fields = blocksOf(payload)[1].fields?.map(f => f.text) ?? [];
    expect(fields).toContain('*Request*\n12345');
    expect(fields).toContain('*User*\n[object Object]');
    expect(fields.some(f => f.startsWith('*Session*'))).toBe(false);
  });

  it('clips a runaway headline', () => {
    const payload = render({ message: 'x'.repeat(500) });
    expect(payload.text.length).toBeLessThan(330);
    expect(payload.text.endsWith('...')).toBe(true);
  });
});

describe('metadata fallbacks', () => {
  const contextTexts = (payload: ReturnType<typeof render>) =>
    blocksOf(payload)
      .filter(b => b.type === 'context')
      .map(b => b.elements?.[0].text ?? '');

  it('takes title and stack frames from metadata.error when the message has no JSON', () => {
    const payload = render({
      message: 'Request failed',
      metadata: {
        ...metadata,
        error: { code: 'E_BOOM', name: 'TypeError', message: 'x is not a function', stack: oktaStack },
      },
    });
    const blocks = blocksOf(payload);
    expect(blocks[0].text?.text).toContain('Request failed: TypeError: x is not a function');
    expect(blocks[1].fields?.map(f => f.text)).toContain('*Code*\nE_BOOM');
    expect(blocks[2].text?.text).toContain('*First frame*');
    expect(blocks[2].text?.text).toContain('at errorHandler');
  });

  it('joins a stack given as an array of lines in metadata.error', () => {
    const payload = render({
      message: 'Request failed',
      metadata: { ...metadata, error: { message: 'boom', stack: ['Error: boom', '    at a (/x.js:1:1)'] } },
    });
    expect(blocksOf(payload)[2].text?.text).toContain('at a (/x.js:1:1)');
  });

  it('uses a string metadata.error as the error message', () => {
    const payload = render({ message: 'Request failed', metadata: { ...metadata, error: 'connection reset' } });
    expect(blocksOf(payload)[0].text?.text).toContain('Request failed: connection reset');
  });

  it('prefers the error parsed from the message over metadata.error', () => {
    const payload = render({ metadata: { ...metadata, error: 'ignored text' } });
    expect(blocksOf(payload)[0].text?.text).not.toContain('ignored text');
  });

  it('lists leftover scalar metadata in one context block before the CloudWatch link', () => {
    const payload = render({
      metadata: {
        ...metadata,
        questId: 'q1',
        organizationId: 'org<1>',
        statusCode: 502,
        model: 'm&n',
        retried: false,
        nested: { a: 1 },
        list: [1],
        empty: '',
      },
    });
    const contexts = contextTexts(payload);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(
      'questId: q1  |  organizationId: org&lt;1&gt;  |  statusCode: 502  |  model: m&amp;n  |  retried: false'
    );
    expect(contexts[1]).toContain('Open in CloudWatch');
  });

  it('leaves out request fields, the log line itself and other excluded keys', () => {
    const payload = render({
      metadata: {
        ...metadata,
        userId: 'u1',
        level: 'error',
        timestamp: 't',
        time: 't',
        ts: 1,
        msg: 'm',
        stack: 's',
        error: 'e',
      },
    });
    expect(contextTexts(payload)).toHaveLength(1);
  });

  it('keeps the leftover block under the Slack context limit', () => {
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, '<&>'.repeat(40)]));
    const [leftover] = contextTexts(render({ metadata: { ...metadata, ...wide } }));
    expect(leftover.length).toBeLessThanOrEqual(3000);
  });
});

describe('splitErrorDetail', () => {
  it('splits headline and JSON detail', () => {
    const { headline, detail } = splitErrorDetail('Failed {"code":"X","stack":"Error: x\\n    at a (b:1:1)"}');
    expect(headline).toBe('Failed');
    expect(detail?.code).toBe('X');
    expect(stackFrames(detail?.stack)).toEqual(['at a (b:1:1)']);
  });

  it('keeps the first line when the tail is not JSON', () => {
    expect(splitErrorDetail('Weird {not json\nline two')).toEqual({ headline: 'Weird {not json' });
  });
});

describe('errorTitle', () => {
  it('appends the error name and message when the headline lacks them', () => {
    expect(errorTitle('Boom', { name: 'TypeError', message: 'bad' })).toBe('Boom: TypeError: bad');
  });

  it('does not repeat a message the headline already carries', () => {
    expect(errorTitle('Boom: bad', { message: 'bad' })).toBe('Boom: bad');
  });

  it('does not double a name the message already starts with', () => {
    expect(errorTitle('', { name: 'TypeError', message: 'TypeError: bad' })).toBe('TypeError: bad');
  });

  it('falls back to Error when nothing is known', () => {
    expect(errorTitle('', undefined)).toBe('Error');
  });
});

describe('fallback text', () => {
  it('escapes the headline so a log line cannot smuggle a mention', () => {
    expect(render({ message: '<!here> broke & died' }).text).toBe(
      'ERROR on production: &lt;!here&gt; broke &amp; died'
    );
  });
});
