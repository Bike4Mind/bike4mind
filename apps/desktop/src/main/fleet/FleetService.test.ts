import { describe, expect, it, vi } from 'vitest';
import type { FleetState } from '@shared/fleet';
import type { SecretCipher, VaultFile } from '../auth/tokenVault';
import type { ActivityBatch, ActivityEvent } from './activityContract';
import { ActivityQueue } from './ActivityQueue';
import { FleetClient, fleetOrigin, type FetchPort } from './FleetClient';
import { FLUSH_DELAY_MS, FleetService } from './FleetService';
import { FleetSettingsStore } from './FleetSettingsStore';

const KEY = `flmt_${'a'.repeat(12)}_${'1'.repeat(48)}`;
const OTHER_KEY = `flmt_${'b'.repeat(12)}_${'2'.repeat(48)}`;
const ORIGIN = 'https://staging.fleet.example.test';

function memoryFile(initial: string | null = null): VaultFile & { contents: string | null } {
  return {
    contents: initial,
    async read() {
      return this.contents;
    },
    async write(contents: string) {
      this.contents = contents;
    },
  };
}

const cipher = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: plain => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: encrypted => encrypted.toString('utf8').slice(4),
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const statusOk = (scopes = ['bike4mind:activity:write']) =>
  json(200, {
    version: 1,
    connected: true,
    consumer: 'poy-desktop',
    scopes,
    capabilities: { status: true, activityIngest: true, summary: true },
  });

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
  sent: ActivityBatch[];
  states: FleetState[];
  logs: string[];
  settingsFile: ReturnType<typeof memoryFile>;
  queueFile: ReturnType<typeof memoryFile>;
  timers: Array<{ callback: () => void; ms: number }>;
}

async function harness(respond: (url: string, init: RequestInit) => Response | Promise<Response>): Promise<Harness> {
  const sent: ActivityBatch[] = [];
  const states: FleetState[] = [];
  const logs: string[] = [];
  const timers: Harness['timers'] = [];
  const fetch = vi.fn<FetchPort>(async (url, init) => {
    if (init.method === 'POST') sent.push(JSON.parse(String(init.body)) as ActivityBatch);
    return respond(url, init);
  });
  const settingsFile = memoryFile();
  const queueFile = memoryFile();
  const logger = { warn: (message: string) => logs.push(message) };
  const service = new FleetService({
    settings: new FleetSettingsStore(cipher(), settingsFile, logger),
    queue: new ActivityQueue(queueFile),
    client: new FleetClient(fetch),
    defaultUrl: ORIGIN,
    logger,
    onState: state => states.push(state),
    setTimer: (callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  await service.initialize();
  return { service, fetch, sent, states, logs, settingsFile, queueFile, timers };
}

describe('fleetOrigin', () => {
  it('accepts https and local http only, and drops the path', () => {
    expect(fleetOrigin('https://fleet.example.test/some/path')).toBe('https://fleet.example.test');
    expect(fleetOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(fleetOrigin('http://fleet.example.test')).toBeNull();
    expect(fleetOrigin('https://user:pass@fleet.example.test')).toBeNull();
    expect(fleetOrigin('not a url')).toBeNull();
  });
});

describe('FleetService settings', () => {
  it('rejects a malformed key and a non-https URL without saving anything', async () => {
    const h = await harness(() => statusOk());
    expect(await h.service.save({ url: ORIGIN, key: 'not-a-key' })).toMatchObject({ ok: false });
    expect(await h.service.save({ url: 'http://fleet.example.test', key: KEY })).toMatchObject({ ok: false });
    expect(h.service.getState().keyConfigured).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('stores the key encrypted, checks it, and never hands it back in state', async () => {
    const h = await harness(() => statusOk());
    const result = await h.service.save({ url: ORIGIN, key: KEY });
    expect(result).toMatchObject({ ok: true });
    expect(h.settingsFile.contents).not.toContain(KEY);
    expect(h.fetch.mock.calls[0][0]).toBe(`${ORIGIN}/api/integrations/bike4mind/status`);
    expect((h.fetch.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const state = h.service.getState();
    expect(state).toMatchObject({ keyConfigured: true, status: 'paused', consent: false });
    expect(state.lastCheck).toMatchObject({ ok: true, consumer: 'poy-desktop', scopes: ['bike4mind:activity:write'] });
    expect(JSON.stringify(h.states)).not.toContain(KEY);
  });

  it('reports a refused key on the connection check', async () => {
    const h = await harness(() => json(401, { error: 'unauthorized' }));
    await h.service.save({ url: ORIGIN, key: KEY });
    expect(h.service.getState().lastCheck).toMatchObject({ ok: false, refused: true });
  });

  it('a refused connection check stops sending, and a passing one resumes it', async () => {
    let refuse = false;
    const h = await harness(() => (refuse ? json(401, { error: 'unauthorized' }) : statusOk()));
    await h.service.save({ url: ORIGIN, key: KEY });
    await h.service.setConsent(true);
    refuse = true;
    expect(await h.service.testConnection()).toMatchObject({ status: 'reconnect-needed' });
    refuse = false;
    expect(await h.service.testConnection()).toMatchObject({ status: 'active' });
  });

  it('an unreachable Fleet on the connection check does not stop sending', async () => {
    const h = await harness(() => statusOk());
    await h.service.save({ url: ORIGIN, key: KEY });
    await h.service.setConsent(true);
    h.fetch.mockRejectedValueOnce(new Error('offline'));
    const state = await h.service.testConnection();
    expect(state.lastCheck).toMatchObject({ ok: false, refused: false });
    expect(state.status).toBe('active');
  });
});

describe('FleetService consent gate', () => {
  it('records and sends nothing while consent is off', async () => {
    const h = await harness(() => statusOk());
    await h.service.save({ url: ORIGIN, key: KEY });
    await h.service.record([event(), event()]);
    expect(h.service.getState().pending).toBe(0);
    expect(h.sent).toHaveLength(0);
    expect(h.queueFile.contents).toBeNull();
  });

  it('turning consent off empties the unsent queue', async () => {
    const h = await harness(() => statusOk());
    await h.service.save({ url: ORIGIN, key: KEY });
    await h.service.setConsent(true);
    await h.service.record([event(), event()]);
    expect(h.service.getState().pending).toBe(2);
    await h.service.setConsent(false);
    expect(h.service.getState().pending).toBe(0);
    expect(JSON.parse(h.queueFile.contents!)).toEqual([]);
  });
});

describe('FleetService sending', () => {
  it('schedules a flush, sends the batch, and clears it on 200', async () => {
    const h = await harness((_url, init) =>
      init.method === 'POST' ? json(200, { ok: true, version: 1, accepted: 2, duplicates: 0 }) : statusOk()
    );
    await h.service.save({ url: ORIGIN, key: KEY });
    await h.service.setConsent(true);
    await h.service.record([event(), event()]);
    expect(h.timers.at(-1)?.ms).toBe(FLUSH_DELAY_MS);
    await h.service.sendNow();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ version: 1, consent: true });
    expect(h.sent[0].events).toHaveLength(2);
    expect(h.service.getState()).toMatchObject({
      pending: 0,
      lastResult: { accepted: 2, duplicates: 0 },
      lastError: null,
    });
  });

  it('retries a failed send with the same event ids, so Fleet can dedupe it', async () => {
    let fail = true;
    const h = await harness((_url, init) => {
      if (init.method !== 'POST') return statusOk();
      if (fail) return json(502, { error: 'bad gateway' });
      return json(200, { ok: true, version: 1, accepted: 0, duplicates: 1 });
    });
    await h.service.save({ url: ORIGIN, key: KEY });
    await h.service.setConsent(true);
    await h.service.record([event()]);
    await h.service.sendNow();
    expect(h.service.getState().pending).toBe(1);
    expect(h.timers.at(-1)?.ms).toBe(FLUSH_DELAY_MS);
    fail = false;
    await h.service.sendNow();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].events[0].eventId).toBe(h.sent[0].events[0].eventId);
    expect(h.service.getState()).toMatchObject({ pending: 0, lastResult: { accepted: 0, duplicates: 1 } });
  });

  it('backs off exponentially on repeated failures', async () => {
    const h = await harness((_url, init) => (init.method === 'POST' ? json(503, {}) : statusOk()));
    await h.service.save({ url: ORIGIN, key: KEY });
    await h.service.setConsent(true);
    await h.service.record([event()]);
    await h.service.sendNow();
    h.timers.at(-1)!.callback();
    await vi.waitFor(() => expect(h.timers.at(-1)?.ms).toBe(FLUSH_DELAY_MS * 2));
  });

  it('stops sending on 401/403 until the key changes', async () => {
    let refuse = true;
    const h = await harness((_url, init) => {
      if (init.method !== 'POST') return statusOk();
      return refuse ? json(403, { error: 'insufficient scope' }) : json(200, { ok: true, accepted: 1, duplicates: 0 });
    });
    await h.service.save({ url: ORIGIN, key: KEY });
    await h.service.setConsent(true);
    await h.service.record([event()]);
    await h.service.sendNow();
    expect(h.service.getState()).toMatchObject({ status: 'reconnect-needed', pending: 1 });
    await h.service.sendNow();
    expect(h.sent).toHaveLength(1);
    refuse = false;
    await h.service.save({ url: ORIGIN, key: OTHER_KEY });
    await h.service.sendNow();
    expect(h.service.getState()).toMatchObject({ status: 'active', pending: 0 });
  });

  it('drops a batch Fleet rejects as invalid instead of retrying it forever, logging only the status', async () => {
    const h = await harness((_url, init) =>
      init.method === 'POST' ? json(400, { error: 'invalid activity batch' }) : statusOk()
    );
    await h.service.save({ url: ORIGIN, key: KEY });
    await h.service.setConsent(true);
    await h.service.record([event()]);
    await h.service.sendNow();
    expect(h.service.getState().pending).toBe(0);
    expect(h.logs.join('\n')).toContain('(400)');
    expect(h.logs.join('\n')).not.toContain(KEY);
    expect(h.logs.join('\n')).not.toContain('session-0001');
  });

  it('keeps the queue across a restart', async () => {
    const queueFile = memoryFile();
    const settingsFile = memoryFile();
    const make = () =>
      new FleetService({
        settings: new FleetSettingsStore(cipher(), settingsFile, { warn: () => undefined }),
        queue: new ActivityQueue(queueFile),
        client: new FleetClient(async () => statusOk()),
        defaultUrl: ORIGIN,
        logger: { warn: () => undefined },
        onState: () => undefined,
        setTimer: () => 1,
        clearTimer: () => undefined,
      });
    const first = make();
    await first.initialize();
    await first.save({ url: ORIGIN, key: KEY });
    await first.setConsent(true);
    await first.record([event(), event()]);
    const second = make();
    await second.initialize();
    expect(second.getState()).toMatchObject({ pending: 2, keyConfigured: true, consent: true, status: 'active' });
  });
});
