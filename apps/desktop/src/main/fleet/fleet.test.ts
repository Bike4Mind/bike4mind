import { describe, expect, it, vi, afterEach } from 'vitest';
import { ActivityQueue, MAX_QUEUED_EVENTS } from './ActivityQueue';
import { FleetClient, fleetOrigin, type FetchPort, type IngestOutcome } from './FleetClient';
import { parseFleetConfig, readFleetConfig, type FleetConfigFs, type FleetConfigResult } from './FleetConfig';
import { FLUSH_DELAY_MS, FleetService } from './FleetService';
import { FleetSettingsStore } from './FleetSettingsStore';
import { memoryFile } from './memoryFile.testHelper';
import { toOtlpLogs } from './otlp';
import { format } from 'node:util';
import {
  MAX_EVENT_AGE_MS,
  MAX_BATCH_EVENTS,
  MAX_DURATION_MS,
  clampDuration,
  isValidEvent,
  nextBatch,
  toolCategory,
  MAX_USAGE_COUNT,
  type ActivityBatch,
  type ActivityEvent,
} from './activityContract';
import { ActivityRecorder } from './ActivityRecorder';
import { parseRemote } from './repository';
import { toReplyUsage, usageTotals } from './replyUsage';
import type { FleetState } from '@shared/fleet';
import type { VaultFile } from '../auth/tokenVault';
import type { ChatStreamEvent, ChatToolCall } from '@shared/chat';

describe('FleetService', () => {
  // Conditions here hold a few promise turns in; vi.waitFor's default 50ms poll would wait each one out.
  const waitFor = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { interval: 1 });

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
    ).resourceLogs[0].scopeLogs[0].logRecords.map(
      r => r.attributes.find(a => a.key === 'event.id')!.value.stringValue!
    );

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
      const missing: FleetConfigFs = {
        stat: async () => Promise.reject(new Error('ENOENT')),
        readFile: async () => '',
      };
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
      await waitFor(() => expect(writing).toHaveBeenCalledTimes(1));
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
      await waitFor(() => expect(h.sent).toHaveLength(1));
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
      await waitFor(() => expect(h.timers.at(-1)?.ms).toBe(FLUSH_DELAY_MS * 2));
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
      await waitFor(() => expect(h.sent).toHaveLength(2));
      await waitFor(() => expect(h.timers.at(-1)?.ms).toBe(FLUSH_DELAY_MS * 2));
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
});

describe('FleetClient', () => {
  const ORIGIN = 'https://fleet.example.test';
  const KEY = 'fltk_test_telemetry_key_AAAA1111';

  const respond = (status: number) => new Response(status === 204 ? null : '{}', { status });

  describe('FleetClient', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('posts the body to the logs path with the bearer key', async () => {
      const fetch = vi.fn<FetchPort>(async () => respond(200));
      await new FleetClient(fetch).sendLogs(ORIGIN, KEY, { a: 1 });
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(`${ORIGIN}/v1/logs`);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
      expect(init.body).toBe('{"a":1}');
    });

    it('never follows a redirect, so a 3xx cannot carry the bearer key elsewhere', async () => {
      const fetch = vi.fn<FetchPort>(async () => respond(200));
      await new FleetClient(fetch).sendLogs(ORIGIN, KEY, {});
      expect(fetch.mock.calls[0][1].redirect).toBe('error');
    });

    it('maps each status to the outcome the queue acts on', async () => {
      const outcomes: Record<number, IngestOutcome> = {
        200: { kind: 'accepted' },
        204: { kind: 'accepted' },
        400: { kind: 'rejected', status: 400 },
        413: { kind: 'rejected', status: 413 },
        415: { kind: 'rejected', status: 415 },
        401: { kind: 'unauthorized', status: 401 },
        403: { kind: 'unauthorized', status: 403 },
        302: { kind: 'retry', status: 302 },
        404: { kind: 'retry', status: 404 },
        429: { kind: 'retry', status: 429 },
        500: { kind: 'retry', status: 500 },
        503: { kind: 'retry', status: 503 },
      };
      for (const [status, expected] of Object.entries(outcomes)) {
        const client = new FleetClient(async () => respond(Number(status)));
        expect(await client.sendLogs(ORIGIN, KEY, {}), `status ${status}`).toEqual(expected);
      }
    });

    it('never logs the API key when fetch throws, and retries with no status', async () => {
      const spies = (['log', 'info', 'warn', 'error'] as const).map(method =>
        vi.spyOn(console, method).mockImplementation(() => undefined)
      );
      const client = new FleetClient(async () => {
        throw new TypeError(`redirect mode is set to error ${KEY}`);
      });
      const result = await client.sendLogs(ORIGIN, KEY, {});
      expect(result).toEqual({ kind: 'retry', status: null });
      expect(JSON.stringify(result)).not.toContain(KEY);
      // util.format renders an Error's message and stack, which JSON.stringify drops
      for (const spy of spies) expect(spy.mock.calls.map(call => format(...call)).join('\n')).not.toContain(KEY);
    });

    it('aborts a request still pending after 15 seconds and retries', async () => {
      vi.useFakeTimers();
      let signal: AbortSignal | null | undefined;
      const fetch: FetchPort = (_url, init) => {
        signal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      };
      const result = new FleetClient(fetch).sendLogs(ORIGIN, KEY, {});
      await vi.advanceTimersByTimeAsync(14_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(await result).toEqual({ kind: 'retry', status: null });
    });

    it('clears the timeout once the request settles', async () => {
      vi.useFakeTimers();
      await new FleetClient(async () => respond(200)).sendLogs(ORIGIN, KEY, {});
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('ActivityQueue', () => {
  const event: ActivityEvent = {
    eventId: 'event-000001',
    occurredAt: new Date().toISOString(),
    durationMs: 1000,
    type: 'session',
    sessionId: 'session-0001',
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => {
      resolve = done;
    });
    return { promise, resolve };
  }

  const eventAt = (n: number, occurredAt = event.occurredAt): ActivityEvent => ({
    ...event,
    eventId: `event-${String(n).padStart(6, '0')}`,
    occurredAt,
  });

  describe('ActivityQueue persistence', () => {
    it('drops the oldest events first once past the cap, on disk as well as in memory', async () => {
      const file = memoryFile();
      const queue = new ActivityQueue(file);
      const all = Array.from({ length: MAX_QUEUED_EVENTS + 3 }, (_, i) => eventAt(i + 1));
      await queue.push(all.slice(0, MAX_QUEUED_EVENTS));
      await queue.push(all.slice(MAX_QUEUED_EVENTS));
      expect(await queue.size()).toBe(MAX_QUEUED_EVENTS);
      const onDisk = JSON.parse(file.contents!) as ActivityEvent[];
      expect(onDisk).toHaveLength(MAX_QUEUED_EVENTS);
      expect(onDisk[0].eventId).toBe('event-000004');
      expect(onDisk.at(-1)?.eventId).toBe(`event-${String(MAX_QUEUED_EVENTS + 3).padStart(6, '0')}`);
    });

    it.each(['{"events":[]}', '"text"', '42', 'null', '{not json', ''])(
      'loads %j as an empty queue and warns at most once',
      async contents => {
        const warn = vi.fn();
        const queue = new ActivityQueue(memoryFile(contents), Date.now, { warn });
        expect(await queue.size()).toBe(0);
        expect(await queue.peek()).toBeNull();
        expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
      }
    );

    it('warns when the file is corrupt but stays quiet for a missing one', async () => {
      const warn = vi.fn();
      await new ActivityQueue(memoryFile('{not json'), Date.now, { warn }).size();
      expect(warn.mock.calls).toEqual([['FLEET: activity queue unreadable, starting empty']]);
      warn.mockClear();
      await new ActivityQueue(memoryFile(null), Date.now, { warn }).size();
      expect(warn).not.toHaveBeenCalled();
    });

    it('drops events older than the maximum age in peek and persists the drop', async () => {
      const now = Date.parse('2026-06-01T00:00:00.000Z');
      const stale = eventAt(1, new Date(now - MAX_EVENT_AGE_MS - 1000).toISOString());
      const fresh = eventAt(2, new Date(now - MAX_EVENT_AGE_MS + 60_000).toISOString());
      const file = memoryFile(JSON.stringify([stale, fresh]));
      const queue = new ActivityQueue(file, () => now);
      expect((await queue.peek())?.events).toEqual([fresh]);
      expect(JSON.parse(file.contents!)).toEqual([fresh]);
      expect(await queue.size()).toBe(1);
    });

    it('does not rewrite the file when peek finds nothing to drop', async () => {
      const file = memoryFile(JSON.stringify([event]));
      const write = vi.spyOn(file, 'write');
      await new ActivityQueue(file).peek();
      expect(write).not.toHaveBeenCalled();
    });

    it('removes only the given event ids and persists the rest', async () => {
      const file = memoryFile();
      const queue = new ActivityQueue(file);
      await queue.push([eventAt(1), eventAt(2), eventAt(3)]);
      await queue.remove(['event-000001', 'event-000003']);
      expect((JSON.parse(file.contents!) as ActivityEvent[]).map(e => e.eventId)).toEqual(['event-000002']);
    });

    it('the last-issued of overlapping push and clear wins on disk', async () => {
      const pushLast = memoryFile(null, true);
      const a = new ActivityQueue(pushLast);
      await Promise.all([a.clear(), a.push([eventAt(1)])]);
      expect(JSON.parse(pushLast.contents!)).toHaveLength(1);
      expect(await new ActivityQueue(pushLast).size()).toBe(1);

      const clearLast = memoryFile(null, true);
      const b = new ActivityQueue(clearLast);
      await Promise.all([b.push([eventAt(1)]), b.push([eventAt(2)]), b.clear()]);
      expect(clearLast.contents).toBe('[]');
      expect(await new ActivityQueue(clearLast).size()).toBe(0);
    });
  });

  describe('ActivityQueue ordering', () => {
    it('drops malformed disk entries while retaining valid activity', async () => {
      let contents = JSON.stringify([
        null,
        1,
        {},
        { ...event, type: 'repository' },
        { ...event, type: 'tool', tool: null },
        { ...event, usage: null },
        event,
      ]);
      const file: VaultFile = {
        read: async () => contents,
        write: async value => {
          contents = value;
        },
      };
      const queue = new ActivityQueue(file);
      expect((await queue.peek())?.events).toEqual([event]);
      expect(JSON.parse(contents)).toEqual([event]);
    });

    it('reports a failed clear and permits a successful retry before restart', async () => {
      let contents = JSON.stringify([event]);
      let fail = true;
      const file: VaultFile = {
        read: async () => contents,
        write: async value => {
          if (fail) throw new Error('disk unavailable');
          contents = value;
        },
      };
      const queue = new ActivityQueue(file, Date.now, { warn: () => undefined });
      await expect(queue.clear()).rejects.toThrow('Failed to clear activity queue');
      fail = false;
      await queue.clear();
      expect(await new ActivityQueue(file).size()).toBe(0);
    });

    it('warns without file or event contents and recovers after a write failure', async () => {
      const warn = vi.fn();
      const file: VaultFile = {
        read: async () => '{invalid-json',
        write: vi.fn().mockRejectedValueOnce(new Error('private contents')).mockResolvedValue(undefined),
      };
      const queue = new ActivityQueue(file, Date.now, { warn });
      await queue.push([event]);
      await queue.clear();
      expect(warn.mock.calls).toEqual([
        ['FLEET: activity queue unreadable, starting empty'],
        ['FLEET: failed to write activity queue'],
      ]);
      expect(file.write).toHaveBeenLastCalledWith('[]');
    });

    it('loads once when startup size and push overlap', async () => {
      const read = deferred<string | null>();
      let contents: string | null = null;
      const file: VaultFile = {
        read: vi.fn(() => read.promise),
        write: async value => {
          contents = value;
        },
      };
      const queue = new ActivityQueue(file);
      const size = queue.size();
      const push = queue.push([event]);
      read.resolve('[]');
      await Promise.all([size, push]);
      expect(file.read).toHaveBeenCalledTimes(1);
      expect(await queue.size()).toBe(1);
      expect(JSON.parse(contents!)).toEqual([event]);
    });

    it('persists clear after an in-flight push, including after restart', async () => {
      const writing = deferred<void>();
      let contents: string | null = null;
      const file: VaultFile = {
        read: async () => contents,
        write: vi.fn(async value => {
          if (value !== '[]') await writing.promise;
          contents = value;
        }),
      };
      const queue = new ActivityQueue(file);
      const push = queue.push([event]);
      await vi.waitFor(() => expect(file.write).toHaveBeenCalledTimes(1));
      const clear = queue.clear();
      writing.resolve();
      await Promise.all([push, clear]);
      expect(contents).toBe('[]');
      expect(await new ActivityQueue(file).size()).toBe(0);
      expect(await queue.size()).toBe(0);
    });

    it('keeps clear last even when push is still loading', async () => {
      const read = deferred<string | null>();
      let contents: string | null = null;
      const file: VaultFile = {
        read: () => read.promise,
        write: async value => {
          contents = value;
        },
      };
      const queue = new ActivityQueue(file);
      const push = queue.push([event]);
      const clear = queue.clear();
      read.resolve('[]');
      await Promise.all([push, clear]);
      expect(contents).toBe('[]');
      expect(await queue.size()).toBe(0);
    });
  });
});

describe('ActivityRecorder', () => {
  // Conditions here hold a few promise turns in; vi.waitFor's default 50ms poll would wait each one out.
  const waitFor = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { interval: 1 });

  const SESSION = '11111111-2222-4333-8444-555555555555';
  const T0 = Date.parse('2026-10-16T12:00:00.000Z');

  function setup(
    enabled = true,
    repository: { owner: string; name: string } | null = { owner: 'acme', name: 'app' },
    model: string | null = 'claude-opus-5',
    lookUpModel: () => Promise<string | null> = async () => model
  ) {
    let now = T0;
    let n = 0;
    const recorded: ActivityEvent[] = [];
    const modelFor = vi.fn(lookUpModel);
    const recorder = new ActivityRecorder({
      enabled: () => enabled,
      record: events => recorded.push(...events),
      repositoryFor: vi.fn(async () => repository),
      modelFor,
      now: () => now,
      newId: () => `event-${String(++n).padStart(4, '0')}`,
    });
    return {
      recorder,
      recorded,
      modelFor,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  const call = (over: Partial<ChatToolCall>): ChatToolCall =>
    ({
      id: 'call-1',
      name: 'bash_execute',
      input: { command: 'cat secrets.txt' },
      status: 'done',
      ...over,
    }) as ChatToolCall;

  const ev = (event: Record<string, unknown>) =>
    ({ sessionId: SESSION, messageId: 'reply-1', ...event }) as ChatStreamEvent;

  describe('ActivityRecorder', () => {
    it('turns a reply into session, tool and repository events, metadata only', async () => {
      const { recorder, recorded, advance } = setup();
      recorder.observe(ev({ type: 'start' }));
      recorder.observe(ev({ type: 'tool-end', call: call({ startedAt: T0 + 1000, endedAt: T0 + 4000 }) }));
      recorder.observe(
        ev({
          type: 'tool-end',
          call: call({ id: 'call-2', name: 'file_edit', startedAt: T0 + 5000, endedAt: T0 + 5500 }),
        })
      );
      advance(30_000);
      recorder.observe(ev({ type: 'done', content: 'the reply text' }));
      await waitFor(() => expect(recorded).toHaveLength(4));

      expect(recorded[0]).toEqual({
        eventId: 'event-0001',
        occurredAt: new Date(T0 + 1000).toISOString(),
        durationMs: 3000,
        type: 'tool',
        sessionId: SESSION,
        tool: { type: 'shell' },
      });
      expect(recorded[1]).toMatchObject({ type: 'tool', tool: { type: 'editor' }, durationMs: 500 });
      expect(recorded[2]).toMatchObject({
        type: 'session',
        durationMs: 30_000,
        occurredAt: new Date(T0).toISOString(),
      });
      expect(recorded[3]).toMatchObject({
        type: 'repository',
        repository: { owner: 'acme', name: 'app', action: 'edit' },
        durationMs: 30_000,
      });
      const wire = JSON.stringify(recorded);
      for (const leaked of ['secrets.txt', 'bash_execute', 'file_edit', 'the reply text'])
        expect(wire).not.toContain(leaked);
    });

    it('marks a reply that changed no files as a view, and skips the repository when there is none', async () => {
      const viewed = setup();
      viewed.recorder.observe(ev({ type: 'start' }));
      viewed.recorder.observe(ev({ type: 'done', content: '' }));
      await waitFor(() => expect(viewed.recorded).toHaveLength(2));
      expect(viewed.recorded[1]).toMatchObject({ repository: { action: 'view' } });

      const none = setup(true, null);
      none.recorder.observe(ev({ type: 'start' }));
      none.recorder.observe(ev({ type: 'error', message: 'boom' }));
      await waitFor(() => expect(none.recorded).toHaveLength(1));
      expect(none.recorded[0].type).toBe('session');
    });

    it('records nothing while disabled, and ignores denied or never-run tools', async () => {
      const off = setup(false);
      off.recorder.observe(ev({ type: 'start' }));
      off.recorder.observe(ev({ type: 'tool-end', call: call({ startedAt: T0, endedAt: T0 + 10 }) }));
      off.recorder.observe(ev({ type: 'done', content: '' }));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(off.recorded).toEqual([]);

      const on = setup();
      on.recorder.observe(ev({ type: 'tool-end', call: call({ status: 'denied', startedAt: T0, endedAt: T0 + 10 }) }));
      on.recorder.observe(ev({ type: 'tool-end', call: call({ status: 'error' }) }));
      expect(on.recorded).toEqual([]);
    });

    it('does not record a completed reply after sharing is disabled during repository lookup', async () => {
      let enabled = true;
      let resolve!: (repository: { owner: string; name: string }) => void;
      const repository = new Promise<{ owner: string; name: string }>(done => {
        resolve = done;
      });
      const record = vi.fn();
      const recorder = new ActivityRecorder({
        enabled: () => enabled,
        record,
        repositoryFor: () => repository,
        modelFor: async () => null,
        now: () => T0,
      });
      recorder.observe(ev({ type: 'start' }));
      recorder.observe(ev({ type: 'done', content: '' }));
      enabled = false;
      resolve({ owner: 'team', name: 'app' });
      await repository;
      await new Promise<void>(done => setImmediate(done));
      expect(record).not.toHaveBeenCalled();
    });
  });

  const usage = (over: Record<string, number> = {}) => ({
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadInputTokens: 5000,
    cacheCreationInputTokens: 40,
    creditsUsed: 265.4,
    usdCost: 0.0123,
    ...over,
  });

  describe('ActivityRecorder usage', () => {
    it('puts the model, tokens and credits on the session event, counts only', async () => {
      const { recorder, recorded } = setup();
      recorder.observe(ev({ type: 'start' }));
      recorder.observe(ev({ type: 'done', content: 'the reply text', usage: usage() }));
      await waitFor(() => expect(recorded.length).toBeGreaterThan(0));

      expect(recorded[0]).toMatchObject({
        type: 'session',
        usage: {
          model: 'claude-opus-5',
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 5000,
          cacheWriteTokens: 40,
          creditsMilli: 265_400,
        },
      });
      expect(Object.keys((recorded[0] as { usage: object }).usage).sort()).toEqual([
        'cacheReadTokens',
        'cacheWriteTokens',
        'creditsMilli',
        'inputTokens',
        'model',
        'outputTokens',
      ]);
      expect(JSON.stringify(recorded)).not.toContain('the reply text');
    });

    it('sends no usage for a reply that reported none, or on a model Fleet cannot key on', async () => {
      const none = setup();
      none.recorder.observe(ev({ type: 'start' }));
      none.recorder.observe(ev({ type: 'done', content: '' }));
      await waitFor(() => expect(none.recorded.length).toBeGreaterThan(0));
      expect(none.recorded[0]).not.toHaveProperty('usage');

      const odd = setup(true, null, 'bad#model');
      odd.recorder.observe(ev({ type: 'start' }));
      odd.recorder.observe(ev({ type: 'done', content: '', usage: usage() }));
      await waitFor(() => expect(odd.recorded.length).toBeGreaterThan(0));
      expect(odd.recorded[0]).not.toHaveProperty('usage');

      const unknown = setup(true, null, null);
      unknown.recorder.observe(ev({ type: 'start' }));
      unknown.recorder.observe(ev({ type: 'done', content: '', usage: usage() }));
      await waitFor(() => expect(unknown.recorded.length).toBeGreaterThan(0));
      expect(unknown.recorded[0]).not.toHaveProperty('usage');
    });

    it('keeps what a reply spent before it failed', async () => {
      const { recorder, recorded } = setup();
      recorder.observe(ev({ type: 'start' }));
      recorder.observe(ev({ type: 'usage', usage: usage({ creditsUsed: 10 }) }));
      recorder.observe(ev({ type: 'error', message: 'boom' }));
      await waitFor(() => expect(recorded.length).toBeGreaterThan(0));
      expect(recorded[0]).toMatchObject({ usage: { model: 'claude-opus-5', creditsMilli: 10_000 } });
    });

    it('counts a continued reply once: a resumed run reports only what it added', async () => {
      const { recorder, recorded } = setup();
      recorder.observe(ev({ type: 'start', baseUsage: usage({ creditsUsed: 100, inputTokens: 1000 }) }));
      recorder.observe(ev({ type: 'done', content: '', usage: usage({ creditsUsed: 160, inputTokens: 1800 }) }));
      await waitFor(() => expect(recorded.length).toBeGreaterThan(0));

      expect(recorded[0]).toMatchObject({ type: 'session', usage: { creditsMilli: 60_000, inputTokens: 800 } });
    });

    it('counts a resumed reply once even after a restart', async () => {
      const first = setup();
      first.recorder.observe(ev({ type: 'start' }));
      first.recorder.observe(ev({ type: 'done', content: '', usage: usage({ creditsUsed: 20, inputTokens: 10_000 }) }));
      await waitFor(() => expect(first.recorded.length).toBeGreaterThan(0));
      expect(first.recorded[0]).toMatchObject({ usage: { creditsMilli: 20_000, inputTokens: 10_000 } });

      // A relaunch remembers nothing, so the resumed run's own totals are all the new recorder sees
      // of the earlier part - the conversation is what says where the run started.
      const restarted = setup();
      restarted.recorder.observe(ev({ type: 'start', baseUsage: usage({ creditsUsed: 20, inputTokens: 10_000 }) }));
      restarted.recorder.observe(
        ev({ type: 'done', content: '', usage: usage({ creditsUsed: 40, inputTokens: 70_000 }) })
      );
      await waitFor(() => expect(restarted.recorded.length).toBeGreaterThan(0));
      expect(restarted.recorded[0]).toMatchObject({ usage: { creditsMilli: 20_000, inputTokens: 60_000 } });
    });

    it('sends the session record without usage for a reply that reported none', async () => {
      const { recorder, recorded } = setup(true, null);
      recorder.observe(ev({ type: 'start' }));
      recorder.observe(ev({ type: 'error', message: 'boom' }));
      await waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]).toMatchObject({ type: 'session' });
      expect(recorded[0]).not.toHaveProperty('usage');
    });

    it('ignores an end it never saw a start for', async () => {
      const { recorder, recorded } = setup(true, null);
      recorder.observe(ev({ type: 'done', content: '', usage: usage() }));
      recorder.observe(ev({ type: 'error', message: 'boom' }));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(recorded).toEqual([]);
    });

    it('keeps the session record when the model lookup fails', async () => {
      const { recorder, recorded } = setup(true, null, 'claude-opus-5', async () => {
        throw new Error('that conversation is gone');
      });
      recorder.observe(ev({ type: 'start' }));
      recorder.observe(ev({ type: 'done', content: '', usage: usage() }));
      await waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]).toMatchObject({ type: 'session' });
      expect(recorded[0]).not.toHaveProperty('usage');
    });
  });

  describe('ActivityRecorder usage, disabled', () => {
    it('reads nothing while sharing is off', async () => {
      const off = setup(false);
      off.recorder.observe(ev({ type: 'start' }));
      off.recorder.observe(ev({ type: 'done', content: '', usage: usage() }));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(off.recorded).toEqual([]);
      expect(off.modelFor).not.toHaveBeenCalled();
    });
  });

  describe('parseRemote', () => {
    it.each([
      'file:///Users/test/projects/team/app.git',
      'C:/Users/test/projects/team/app',
      'C:\\Users\\test\\projects\\team\\app',
      'git@host:/team/app.git',
      'git@host:~/team/app.git',
      'git@host:~other/team/app.git',
      'ftp://host/team/app.git',
      'ssh:///team/app.git',
    ])('ignores unsupported remote %s', remote => {
      expect(parseRemote(remote)).toBeNull();
    });

    it.each(['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'])('accepts %s network remotes', scheme => {
      expect(parseRemote(`${scheme}://host/team/app.git`)).toEqual({ owner: 'team', name: 'app' });
    });

    it('keeps only owner and name, whatever the remote form', () => {
      expect(parseRemote('git@github.com:acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
      expect(parseRemote('https://github.com/acme/app')).toEqual({ owner: 'acme', name: 'app' });
      expect(parseRemote('ssh://git@gitlab.example.test/group/app.git')).toEqual({ owner: 'group', name: 'app' });
      expect(parseRemote('https://token@github.com/acme/app.git')).toEqual({ owner: 'acme', name: 'app' });
      expect(parseRemote('/local/path')).toBeNull();
      expect(parseRemote('not a remote')).toBeNull();
    });
  });
});

describe('activityContract', () => {
  const NOW = Date.parse('2026-10-16T12:00:00.000Z');

  const session = (id: string, over: Partial<ActivityEvent> = {}): ActivityEvent =>
    ({
      eventId: id,
      occurredAt: new Date(NOW - 60_000).toISOString(),
      durationMs: 1000,
      type: 'session',
      sessionId: 'session-0001',
      ...over,
    }) as ActivityEvent;

  describe('isValidEvent mirrors Fleet', () => {
    it('accepts session, tool and repository events', () => {
      expect(isValidEvent(session('event-0001'), NOW)).toBe(true);
      expect(isValidEvent({ ...session('event-0002'), type: 'tool', tool: { type: 'shell' } }, NOW)).toBe(true);
      expect(
        isValidEvent(
          { ...session('event-0003'), type: 'repository', repository: { owner: 'acme', name: 'app', action: 'edit' } },
          NOW
        )
      ).toBe(true);
    });

    it('refuses what Fleet refuses', () => {
      expect(isValidEvent(session('short'), NOW)).toBe(false);
      expect(isValidEvent(session('event-0001', { occurredAt: '2026-10-16T11:59:00Z' }), NOW)).toBe(false);
      expect(
        isValidEvent(session('event-0001', { occurredAt: new Date(NOW - 31 * 86_400_000).toISOString() }), NOW)
      ).toBe(false);
      expect(isValidEvent(session('event-0001', { occurredAt: new Date(NOW + 10 * 60_000).toISOString() }), NOW)).toBe(
        false
      );
      expect(isValidEvent(session('event-0001', { durationMs: MAX_DURATION_MS + 1 }), NOW)).toBe(false);
      expect(isValidEvent(session('event-0001', { durationMs: 1.5 }), NOW)).toBe(false);
      expect(
        isValidEvent(
          { ...session('event-0003'), type: 'repository', repository: { owner: '-bad', name: 'app', action: 'edit' } },
          NOW
        )
      ).toBe(false);
    });
  });

  describe('isValidEvent on usage', () => {
    const usage = {
      model: 'claude-opus-5',
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 5000,
      cacheWriteTokens: 40,
      creditsMilli: 265_400,
    };

    it('accepts a session event with usage, and one without', () => {
      expect(isValidEvent(session('event-0001', { usage } as Partial<ActivityEvent>), NOW)).toBe(true);
      expect(isValidEvent(session('event-0002'), NOW)).toBe(true);
      expect(
        isValidEvent(
          session('event-0003', {
            usage: { ...usage, model: 'global.anthropic.claude-sonnet-5-5' },
          } as Partial<ActivityEvent>),
          NOW
        )
      ).toBe(true);
    });

    it('refuses a model Fleet cannot key on, and counts that are negative, fractional or huge', () => {
      for (const bad of [
        { model: 'bad#model' },
        { model: '' },
        { model: 'x'.repeat(101) },
        { inputTokens: -1 },
        { outputTokens: 1.5 },
        { creditsMilli: 2_000_000_000 },
      ]) {
        expect(
          isValidEvent(session('event-0001', { usage: { ...usage, ...bad } } as Partial<ActivityEvent>), NOW),
          JSON.stringify(bad)
        ).toBe(false);
      }
    });
  });

  describe('nextBatch', () => {
    it('takes at most 24 events with unique ids', () => {
      const events = Array.from({ length: 30 }, (_, i) => session(`event-${String(i).padStart(4, '0')}`));
      const batch = nextBatch([...events, events[0]]);
      expect(batch?.events).toHaveLength(MAX_BATCH_EVENTS);
      expect(new Set(batch?.events.map(event => event.eventId)).size).toBe(MAX_BATCH_EVENTS);
      expect(batch).toMatchObject({ version: 1, consent: true });
    });

    it('returns null for an empty queue', () => {
      expect(nextBatch([])).toBeNull();
    });
  });

  describe('toolCategory', () => {
    it('maps tool names to the categories Fleet accepts, never passing the name through', () => {
      expect(toolCategory('bash_execute')).toBe('shell');
      expect(toolCategory('file_edit')).toBe('editor');
      expect(toolCategory('apply_patch')).toBe('editor');
      expect(toolCategory('browser_click')).toBe('browser');
      expect(toolCategory('mcp__github__create_issue')).toBe('mcp');
      expect(toolCategory('session_spawn')).toBe('agent');
      expect(toolCategory('generate_image')).toBe('other');
      expect(toolCategory('orchestrator_label'), 'a display label, not delegation').toBe('other');
    });
  });

  describe('clampDuration', () => {
    it('clamps into 0..24h and rounds', () => {
      expect(clampDuration(-5)).toBe(0);
      expect(clampDuration(Number.NaN)).toBe(0);
      expect(clampDuration(12.6)).toBe(13);
      expect(clampDuration(MAX_DURATION_MS * 2)).toBe(MAX_DURATION_MS);
    });
  });
});

describe('replyUsage', () => {
  const NONE = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    creditsMilli: 0,
  };

  describe('usageTotals', () => {
    it('maps the server figures onto wire counts, credits in thousandths', () => {
      expect(
        usageTotals({
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 40,
          creditsUsed: 0.123,
        })
      ).toEqual({
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 5000,
        cacheWriteTokens: 40,
        creditsMilli: 123,
      });
    });

    it('reads a missing or unusable figure as zero, and rounds a fractional one', () => {
      expect(usageTotals(undefined)).toEqual(NONE);
      expect(
        usageTotals({ inputTokens: -5, outputTokens: Number.NaN, cacheReadInputTokens: Number.POSITIVE_INFINITY })
      ).toEqual(NONE);
      expect(usageTotals({ inputTokens: 1.4, outputTokens: 1.6 })).toMatchObject({ inputTokens: 1, outputTokens: 2 });
    });

    it('clamps a count to what the wire carries', () => {
      expect(usageTotals({ inputTokens: MAX_USAGE_COUNT + 1, creditsUsed: MAX_USAGE_COUNT })).toEqual({
        ...NONE,
        inputTokens: MAX_USAGE_COUNT,
        creditsMilli: MAX_USAGE_COUNT,
      });
    });
  });

  describe('toReplyUsage', () => {
    it('reports only what a run added beyond the totals it started with', () => {
      expect(
        toReplyUsage(
          'claude-opus-5',
          usageTotals({ inputTokens: 70_000, creditsUsed: 40 }),
          usageTotals({ inputTokens: 10_000, creditsUsed: 20 })
        )
      ).toEqual({
        model: 'claude-opus-5',
        inputTokens: 60_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        creditsMilli: 20_000,
      });
    });

    it('is null when nothing new was used, or when Fleet cannot key on the model', () => {
      expect(toReplyUsage('claude-opus-5', usageTotals(undefined))).toBeNull();
      expect(
        toReplyUsage('claude-opus-5', usageTotals({ inputTokens: 100 }), usageTotals({ inputTokens: 100 }))
      ).toBeNull();
      expect(toReplyUsage('bad#model', usageTotals({ inputTokens: 100 }))).toBeNull();
      expect(toReplyUsage(null, usageTotals({ inputTokens: 100 }))).toBeNull();
    });
  });
});
