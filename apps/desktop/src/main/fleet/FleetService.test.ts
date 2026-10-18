import { describe, expect, it, vi } from 'vitest';
import type { FleetState } from '@shared/fleet';
import type { ActivityBatch, ActivityEvent } from './activityContract';
import { ActivityQueue } from './ActivityQueue';
import { FleetClient, fleetOrigin, type FetchPort } from './FleetClient';
import { parseFleetConfig, readFleetConfig, type FleetConfigFs, type FleetConfigResult } from './FleetConfig';
import { FLUSH_DELAY_MS, FleetService } from './FleetService';
import { FleetSettingsStore } from './FleetSettingsStore';
import { memoryFile } from './memoryFile.testHelper';
import { toOtlpLogs } from './otlp';

const KEY = 'fltk_test_telemetry_key_AAAA1111';
const OTHER_KEY = 'fltk_test_telemetry_key_BBBB2222';
const ORIGIN = 'https://fleet.example.test';
const INSTALL_ID = '0123456789abcdef0123456789abcdef';
const EMAIL = 'dev@example.test';

const configJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, endpoint: ORIGIN, key: KEY, email: EMAIL, installId: INSTALL_ID, ...over });

const response = (status: number) =>
  new Response('{"partialSuccess":{}}', { status, headers: { 'content-type': 'application/json' } });

let counter = 0;
const event = (): ActivityEvent => ({
  eventId: `event-${String(++counter).padStart(6, '0')}`,
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
  durationMs: 1000,
  type: 'session',
  sessionId: 'session-0001',
});

interface Harness {
  service: FleetService;
  fetch: ReturnType<typeof vi.fn>;
  sent: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
  states: FleetState[];
  logs: string[];
  queueFile: ReturnType<typeof memoryFile>;
  timers: Array<{ callback: () => void; ms: number }>;
  setConfig(result: FleetConfigResult): void;
}

const connected = (key = KEY): FleetConfigResult => ({
  kind: 'connected',
  config: { endpoint: ORIGIN, key, email: EMAIL, installId: INSTALL_ID },
});

async function harness(
  respond: () => Response | Promise<Response> = () => response(200),
  config: FleetConfigResult = connected()
): Promise<Harness> {
  const sent: Harness['sent'] = [];
  const states: FleetState[] = [];
  const logs: string[] = [];
  const timers: Harness['timers'] = [];
  let current = config;
  const fetch = vi.fn<FetchPort>(async (url, init) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return respond();
  });
  const queueFile = memoryFile();
  const logger = { warn: (message: string) => logs.push(message) };
  const service = new FleetService({
    settings: new FleetSettingsStore(memoryFile(), logger),
    queue: new ActivityQueue(queueFile),
    client: new FleetClient(fetch),
    readConfig: async () => current,
    configPath: '~/.claude/fleet/bike4mind-desktop.json',
    appVersion: '1.2.3',
    logger,
    onState: state => states.push(state),
    setTimer: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  await service.initialize();
  return { service, fetch, sent, states, logs, queueFile, timers, setConfig: next => (current = next) };
}

const eventIds = (body: unknown): string[] =>
  (
    body as {
      resourceLogs: Array<{
        scopeLogs: Array<{
          logRecords: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }>;
        }>;
      }>;
    }
  ).resourceLogs[0].scopeLogs[0].logRecords.map(r => r.attributes.find(a => a.key === 'event.id')!.value.stringValue!);

describe('fleetOrigin', () => {
  it('accepts https and local http only, and drops the path', () => {
    expect(fleetOrigin('https://fleet.example.test/some/path')).toBe('https://fleet.example.test');
    expect(fleetOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(fleetOrigin('http://fleet.example.test')).toBeNull();
    expect(fleetOrigin('https://user:pass@fleet.example.test')).toBeNull();
    expect(fleetOrigin('not a url')).toBeNull();
  });
});

describe('the installer file', () => {
  it('reads a valid file as connected, and one with no email as no-email', () => {
    expect(parseFleetConfig(configJson())).toEqual(connected());
    expect(parseFleetConfig(configJson({ email: '' }))).toMatchObject({ kind: 'no-email', config: { email: null } });
  });

  it('rejects anything it cannot use', () => {
    for (const bad of [
      'not json',
      '[]',
      configJson({ version: 2 }),
      configJson({ endpoint: 'http://fleet.example.test' }),
      configJson({ endpoint: `${ORIGIN}/v1/logs` }),
      configJson({ key: 'short' }),
      configJson({ key: 'has a space in it here' }),
      configJson({ installId: 'nope' }),
    ]) {
      expect(parseFleetConfig(bad)).toEqual({ kind: 'invalid' });
    }
  });

  const fsWith = (mode: number, contents = configJson(), isFile = true): FleetConfigFs => ({
    stat: async () => ({ mode, isFile: () => isFile }),
    readFile: async () => contents,
  });

  it('is not-installed when missing, and ignores a copy other users can read', async () => {
    const missing: FleetConfigFs = { stat: async () => Promise.reject(new Error('ENOENT')), readFile: async () => '' };
    expect(await readFleetConfig('/x', missing, 'darwin')).toEqual({ kind: 'not-installed' });
    expect(await readFleetConfig('/x', fsWith(0o100644), 'darwin')).toEqual({ kind: 'insecure' });
    expect(await readFleetConfig('/x', fsWith(0o100640), 'linux')).toEqual({ kind: 'insecure' });
    expect(await readFleetConfig('/x', fsWith(0o100600), 'darwin')).toEqual(connected());
    expect(await readFleetConfig('/x', fsWith(0o100644), 'win32')).toEqual(connected());
    expect(await readFleetConfig('/x', fsWith(0o40700, '', false), 'darwin')).toEqual({ kind: 'invalid' });
  });
});

describe('toOtlpLogs', () => {
  it('encodes each event type with the contract attributes, and leaves out a missing email', () => {
    const at = '2026-10-16T14:06:35.432Z';
    const batch: ActivityBatch = {
      version: 1,
      consent: true,
      events: [
        { eventId: 'event-aaaaaa', occurredAt: at, durationMs: 3249, type: 'session', sessionId: 'session-0001' },
        {
          eventId: 'event-bbbbbb',
          occurredAt: at,
          durationMs: 12,
          type: 'tool',
          sessionId: 'session-0001',
          tool: { type: 'shell' },
        },
        {
          eventId: 'event-cccccc',
          occurredAt: at,
          durationMs: 3249,
          type: 'repository',
          sessionId: 'session-0001',
          repository: { owner: 'acme', name: 'app', action: 'edit' },
        },
      ],
    };
    const body = toOtlpLogs(batch, { appVersion: '1.2.3', email: EMAIL, installId: INSTALL_ID });
    expect(body).toEqual({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'bike4mind-desktop' } },
              { key: 'service.version', value: { stringValue: '1.2.3' } },
              { key: 'user.email', value: { stringValue: EMAIL } },
              { key: 'fleet.install.id', value: { stringValue: INSTALL_ID } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'bike4mind-desktop', version: '1.2.3' },
              logRecords: [
                {
                  timeUnixNano: '1792159595432000000',
                  severityText: 'INFO',
                  body: { stringValue: 'bike4mind_desktop.session' },
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'bike4mind_desktop.session' } },
                    { key: 'event.id', value: { stringValue: 'event-aaaaaa' } },
                    { key: 'session.id', value: { stringValue: 'session-0001' } },
                    { key: 'duration_ms', value: { intValue: '3249' } },
                  ],
                },
                {
                  timeUnixNano: '1792159595432000000',
                  severityText: 'INFO',
                  body: { stringValue: 'bike4mind_desktop.tool' },
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'bike4mind_desktop.tool' } },
                    { key: 'event.id', value: { stringValue: 'event-bbbbbb' } },
                    { key: 'session.id', value: { stringValue: 'session-0001' } },
                    { key: 'duration_ms', value: { intValue: '12' } },
                    { key: 'tool.category', value: { stringValue: 'shell' } },
                  ],
                },
                {
                  timeUnixNano: '1792159595432000000',
                  severityText: 'INFO',
                  body: { stringValue: 'bike4mind_desktop.repository' },
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'bike4mind_desktop.repository' } },
                    { key: 'event.id', value: { stringValue: 'event-cccccc' } },
                    { key: 'session.id', value: { stringValue: 'session-0001' } },
                    { key: 'duration_ms', value: { intValue: '3249' } },
                    { key: 'repository.owner', value: { stringValue: 'acme' } },
                    { key: 'repository.name', value: { stringValue: 'app' } },
                    { key: 'repository.action', value: { stringValue: 'edit' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const noEmail = toOtlpLogs(batch, { appVersion: '1.2.3', email: null, installId: INSTALL_ID }) as {
      resourceLogs: Array<{ resource: { attributes: Array<{ key: string }> } }>;
    };
    expect(noEmail.resourceLogs[0].resource.attributes.map(a => a.key)).toEqual([
      'service.name',
      'service.version',
      'fleet.install.id',
    ]);
  });
});

describe('toOtlpLogs on usage', () => {
  it('carries the model and counts on the session record as int and string attributes', () => {
    const batch = {
      version: 1 as const,
      consent: true as const,
      events: [
        {
          eventId: 'event-0001',
          occurredAt: '2026-10-16T12:00:00.000Z',
          durationMs: 3249,
          type: 'session' as const,
          sessionId: 'session-0001',
          usage: {
            model: 'claude-opus-5',
            inputTokens: 1200,
            outputTokens: 300,
            cacheReadTokens: 5000,
            cacheWriteTokens: 40,
            creditsMilli: 265_400,
          },
        },
      ],
    };
    const body = toOtlpLogs(batch, { appVersion: '1.2.3', email: EMAIL, installId: INSTALL_ID }) as {
      resourceLogs: Array<{
        scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string; value: unknown }> }> }>;
      }>;
    };
    const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    expect(attrs.slice(4)).toEqual([
      { key: 'model', value: { stringValue: 'claude-opus-5' } },
      { key: 'input_tokens', value: { intValue: '1200' } },
      { key: 'output_tokens', value: { intValue: '300' } },
      { key: 'cache_read_tokens', value: { intValue: '5000' } },
      { key: 'cache_write_tokens', value: { intValue: '40' } },
      { key: 'credits_milli', value: { intValue: '265400' } },
    ]);
  });
});

describe('FleetService connection', () => {
  it('reports the file state and never puts the key in state', async () => {
    const h = await harness();
    expect(h.service.getState()).toMatchObject({
      connection: 'connected',
      email: EMAIL,
      fleetUrl: ORIGIN,
      status: 'paused',
    });
    expect(JSON.stringify(h.states)).not.toContain(KEY);
  });

  it('records nothing without a usable file, including one with no email', async () => {
    for (const config of [
      { kind: 'not-installed' },
      { kind: 'insecure' },
      { kind: 'invalid' },
      { ...connected(), kind: 'no-email' },
    ] as FleetConfigResult[]) {
      const h = await harness(undefined, config);
      await h.service.setConsent(true);
      await h.service.record([event()]);
      expect(h.service.getState()).toMatchObject({ status: 'not-configured', pending: 0 });
    }
  });

  it('picks up an installer run on refresh', async () => {
    const h = await harness(undefined, { kind: 'not-installed' });
    expect(h.service.getState().status).toBe('not-configured');
    h.setConfig(connected());
    expect(await h.service.refresh()).toMatchObject({ connection: 'connected', status: 'paused' });
  });
});

describe('FleetService consent gate', () => {
  it('records and sends nothing while consent is off', async () => {
    const h = await harness();
    await h.service.record([event(), event()]);
    expect(h.service.getState().pending).toBe(0);
    expect(h.sent).toHaveLength(0);
    expect(h.queueFile.contents).toBe('[]');
  });

  it.each([null, '{}', '{"consent":null}', '{"consent":"true"}', ''])('defaults sharing off for %s', async raw => {
    const settings = new FleetSettingsStore(memoryFile(raw), { warn: () => undefined });
    expect(await settings.read()).toEqual({ consent: false });
  });

  it('keeps opt-out last during a record write, then retains no old events on restart', async () => {
    const h = await harness();
    await h.service.setConsent(true);
    const write = h.queueFile.write.bind(h.queueFile);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const writing = vi.fn(async (value: string) => {
      if (value !== '[]') await blocked;
      await write(value);
    });
    h.queueFile.write = writing;
    const record = h.service.record([event()]);
    await vi.waitFor(() => expect(writing).toHaveBeenCalledTimes(1));
    const optOut = h.service.setConsent(false);
    await h.service.record([event()]);
    release();
    await Promise.all([record, optOut]);
    expect(h.service.recording()).toBe(false);
    expect(h.service.getState().pending).toBe(0);
    expect(await new ActivityQueue(h.queueFile).size()).toBe(0);
    await h.service.setConsent(true);
    await h.service.sendNow();
    expect(h.sent).toEqual([]);
    await h.service.record([event()]);
    await h.service.sendNow();
    expect(h.sent).toHaveLength(1);
    expect(eventIds(h.sent[0].body)).toHaveLength(1);
  });

  it('turning consent off empties the unsent queue', async () => {
    const h = await harness();
    await h.service.setConsent(true);
    await h.service.record([event(), event()]);
    expect(h.service.getState().pending).toBe(2);
    await h.service.setConsent(false);
    expect(h.service.getState().pending).toBe(0);
    expect(JSON.parse(h.queueFile.contents!)).toEqual([]);
  });

  it('keeps sharing off across failed clears, re-enable attempts and restart', async () => {
    const settingsFile = memoryFile();
    const queueFile = memoryFile();
    const write = queueFile.write.bind(queueFile);
    let fail = false;
    queueFile.write = async value => {
      if (fail) throw new Error('disk unavailable');
      await write(value);
    };
    const sent = vi.fn(async () => response(200));
    const make = () =>
      new FleetService({
        settings: new FleetSettingsStore(settingsFile, { warn: () => undefined }),
        queue: new ActivityQueue(queueFile, Date.now, { warn: () => undefined }),
        client: new FleetClient(sent),
        readConfig: async () => connected(),
        configPath: '/test/fleet.json',
        appVersion: '1.2.3',
        logger: { warn: () => undefined },
        onState: () => undefined,
        setTimer: () => 1,
        clearTimer: () => undefined,
      });
    const first = make();
    await first.initialize();
    await first.setConsent(true);
    await first.record([event()]);
    fail = true;
    expect(await first.setConsent(false)).toMatchObject({ consent: false, lastError: expect.any(String) });
    expect(await first.setConsent(true)).toMatchObject({ consent: false });
    const restarted = make();
    await restarted.initialize();
    expect(restarted.recording()).toBe(false);
    expect(await restarted.setConsent(true)).toMatchObject({ consent: false });
    await restarted.sendNow();
    expect(sent).not.toHaveBeenCalled();
    fail = false;
    expect(await restarted.setConsent(true)).toMatchObject({ consent: true, pending: 0, lastError: null });
    await restarted.sendNow();
    expect(sent).not.toHaveBeenCalled();
    await restarted.record([event()]);
    await restarted.sendNow();
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe('FleetService sending', () => {
  it('schedules a flush, posts OTLP logs with the installer key, and clears the batch on 200', async () => {
    const h = await harness();
    await h.service.setConsent(true);
    await h.service.record([event(), event()]);
    expect(h.timers.at(-1)?.ms).toBe(FLUSH_DELAY_MS);
    await h.service.sendNow();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].url).toBe(`${ORIGIN}/v1/logs`);
    expect(h.sent[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(eventIds(h.sent[0].body)).toHaveLength(2);
    expect(h.service.getState()).toMatchObject({ pending: 0, lastResult: { sent: 2 }, lastError: null });
  });

  it('sends each event once when sendNow overlaps a timer flush', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const h = await harness(async () => {
      await gate;
      return response(200);
    });
    await h.service.setConsent(true);
    await h.service.record([event(), event()]);
    h.timers.at(-1)!.callback();
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const now = h.service.sendNow();
    release();
    await now;
    expect(h.sent).toHaveLength(1);
    expect(h.service.getState()).toMatchObject({ pending: 0, lastResult: { sent: 2 } });
  });

  it('retries a failed send with the same event ids, so Fleet can dedupe it', async () => {
    let fail = true;
    const h = await harness(() => response(fail ? 502 : 200));
    await h.service.setConsent(true);
    await h.service.record([event()]);
    await h.service.sendNow();
    expect(h.service.getState().pending).toBe(1);
    expect(h.timers.at(-1)?.ms).toBe(FLUSH_DELAY_MS);
    fail = false;
    await h.service.sendNow();
    expect(h.sent).toHaveLength(2);
    expect(eventIds(h.sent[1].body)).toEqual(eventIds(h.sent[0].body));
    expect(h.service.getState().pending).toBe(0);
  });

  it('backs off exponentially on repeated failures', async () => {
    const h = await harness(() => response(503));
    await h.service.setConsent(true);
    await h.service.record([event()]);
    await h.service.sendNow();
    h.timers.at(-1)!.callback();
    await vi.waitFor(() => expect(h.timers.at(-1)?.ms).toBe(FLUSH_DELAY_MS * 2));
  });

  it('keeps the retry timer when further records fill the queue', async () => {
    const h = await harness(() => response(503));
    await h.service.setConsent(true);
    await h.service.record([event()]);
    await h.service.sendNow();
    const retry = h.timers.at(-1)!;
    const timerCount = h.timers.length;
    await h.service.record(Array.from({ length: 24 }, event));
    await h.service.record([event()]);
    expect(h.timers).toHaveLength(timerCount);
    expect(h.timers.at(-1)).toBe(retry);
    expect(h.sent).toHaveLength(1);
    retry.callback();
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    await vi.waitFor(() => expect(h.timers.at(-1)?.ms).toBe(FLUSH_DELAY_MS * 2));
  });

  it('stops on 401 until the installer file carries a new key, then resumes', async () => {
    let refuse = true;
    const h = await harness(() => response(refuse ? 401 : 200));
    await h.service.setConsent(true);
    await h.service.record([event()]);
    await h.service.sendNow();
    expect(h.service.getState()).toMatchObject({ status: 'reconnect-needed', pending: 1 });
    expect(h.service.getState().lastError).toContain('Run the Fleet installer again');
    await h.service.sendNow();
    expect(h.sent).toHaveLength(1);

    await h.service.refresh();
    expect(h.service.getState().status).toBe('reconnect-needed');

    refuse = false;
    h.setConfig(connected(OTHER_KEY));
    await h.service.refresh();
    expect(h.service.getState()).toMatchObject({ status: 'active', lastError: null });
    expect(h.timers.at(-1)?.ms).toBe(0);
    await h.service.sendNow();
    expect(h.sent.at(-1)!.headers.Authorization).toBe(`Bearer ${OTHER_KEY}`);
    expect(h.service.getState().pending).toBe(0);
  });

  it('drops a batch Fleet rejects as invalid instead of retrying it forever, logging only the status', async () => {
    const h = await harness(() => response(400));
    await h.service.setConsent(true);
    await h.service.record([event()]);
    await h.service.sendNow();
    expect(h.service.getState().pending).toBe(0);
    expect(h.logs.join('\n')).toContain('(400)');
    expect(h.logs.join('\n')).not.toContain(KEY);
    expect(h.logs.join('\n')).not.toContain('session-0001');
  });

  it('keeps the queue and the switch across a restart', async () => {
    const queueFile = memoryFile();
    const settingsFile = memoryFile();
    const make = () =>
      new FleetService({
        settings: new FleetSettingsStore(settingsFile, { warn: () => undefined }),
        queue: new ActivityQueue(queueFile),
        client: new FleetClient(async () => response(200)),
        readConfig: async () => connected(),
        configPath: '~/.claude/fleet/bike4mind-desktop.json',
        appVersion: '1.2.3',
        logger: { warn: () => undefined },
        onState: () => undefined,
        setTimer: () => 1,
        clearTimer: () => undefined,
      });
    const first = make();
    await first.initialize();
    await first.setConsent(true);
    await first.record([event(), event()]);
    const second = make();
    await second.initialize();
    expect(second.getState()).toMatchObject({ pending: 2, consent: true, status: 'active' });
  });

  it('ignores the URL and key an older build left in its settings file', async () => {
    const settings = new FleetSettingsStore(
      memoryFile(JSON.stringify({ version: 1, url: ORIGIN, consent: true, key: 'ZW5jOmZsbXRf' })),
      {
        warn: () => undefined,
      }
    );
    expect(await settings.read()).toEqual({ consent: true });
  });
});
