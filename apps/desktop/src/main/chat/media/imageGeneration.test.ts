import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateImage, resolveImageUrls } from './imageGeneration';
import type { MediaApiClient, QuestPoll } from './MediaApiClient';
import { MediaStore } from './MediaStore';

const SESSION = 'f1a2b3c4-0000-4000-8000-000000000001';

const REQUEST = { prompt: 'a bicycle', model: 'gpt-image-1-mini', notebookName: 'New chat' };

interface Harness {
  client: MediaApiClient;
  getQuest: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  fetchGenerated: ReturnType<typeof vi.fn>;
  progress: string[];
  deps: Parameters<typeof generateImage>[1];
}

async function harness(polls: QuestPoll[]): Promise<Harness> {
  const getQuest = vi.fn();
  for (const poll of polls) getQuest.mockResolvedValueOnce(poll);
  getQuest.mockResolvedValue(polls[polls.length - 1]);

  const generate = vi.fn().mockResolvedValue({ questId: 'q1', remoteSessionId: 'nb1' });
  const fetchGenerated = vi.fn().mockResolvedValue({ bytes: Buffer.from('png'), contentType: 'image/png' });
  const client = { generateImage: generate, getQuest, fetchGenerated } as unknown as MediaApiClient;

  const progress: string[] = [];
  return {
    client,
    getQuest,
    generate,
    fetchGenerated,
    progress,
    deps: {
      client,
      store: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-imagegen-'))),
      sessionId: SESSION,
      cdnUrl: '',
      signal: new AbortController().signal,
      progress: text => progress.push(text),
    },
  };
}

/**
 * Settle the generation and hand back whatever it produced, error included.
 *
 * The catch is attached before the timers run on purpose: a rejection that is only awaited
 * afterwards is briefly unhandled while the fake clock advances, which vitest reports as an
 * unhandled rejection and fails the run.
 */
async function settle(promise: Promise<unknown>, advanceMs: number): Promise<unknown> {
  const outcome = promise.then(
    value => value,
    error => error as unknown
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  return outcome;
}

const RUNNING: QuestPoll = { id: 'q1', status: 'running' };
const DONE: QuestPoll = {
  id: 'q1',
  status: 'done',
  sessionId: 'nb1',
  files: [{ name: 'a.png', url: 'https://cdn.example/generated/a.png', isImage: true, isAudio: false }],
};

describe('resolveImageUrls', () => {
  it('prefers the urls the server already resolved', () => {
    expect(resolveImageUrls(DONE, 'https://other.example')).toEqual({
      urls: ['https://cdn.example/generated/a.png'],
      unreachable: [],
    });
  });

  // Self-host and personal dev stages leave `files` empty because the API route reads a CDN base
  // the desktop client can still get from serverConfig.
  it('falls back to the serverConfig base when the quest carries only bare names', () => {
    const quest: QuestPoll = { id: 'q1', status: 'done', images: ['a.png', 'notes.xlsx'], files: [] };
    expect(resolveImageUrls(quest, '/api/app-files/serve/')).toEqual({
      urls: ['/api/app-files/serve/generated/a.png'],
      unreachable: [],
    });
  });

  it('reports names it cannot place rather than pretending nothing was generated', () => {
    const quest: QuestPoll = { id: 'q1', status: 'done', images: ['a.png'], files: [] };
    expect(resolveImageUrls(quest, '')).toEqual({ urls: [], unreachable: ['a.png'] });
  });
});

describe('generateImage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls until the quest settles, reporting elapsed time as it waits', async () => {
    const h = await harness([RUNNING, RUNNING, DONE]);
    const promise = generateImage(REQUEST, h.deps);
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await promise;

    expect(h.getQuest).toHaveBeenCalledTimes(3);
    expect(outcome.remoteSessionId).toBe('nb1');
    expect(outcome.media).toHaveLength(1);
    expect(outcome.media[0]).toMatchObject({ kind: 'image', mimeType: 'image/png', caption: 'a bicycle' });
    expect(outcome.media[0].url).toMatch(/^b4m-media:\/\//);
    // Queued, then a line per unfinished poll, then the download.
    expect(h.progress[0]).toMatch(/Queuing/);
    expect(h.progress.filter(line => /^Generating\.\.\. \d+s$/.test(line))).toHaveLength(2);
    expect(h.progress[h.progress.length - 1]).toMatch(/Downloading/);
  });

  it('names the notebook on the first generation and reuses it afterwards', async () => {
    const first = await harness([DONE]);
    const promise = generateImage(REQUEST, first.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;
    expect(first.generate).toHaveBeenCalledWith(expect.objectContaining({ sessionName: 'New chat' }));

    const again = await harness([DONE]);
    const second = generateImage({ ...REQUEST, remoteSessionId: 'nb1' }, again.deps);
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    expect(again.generate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'nb1' }));
    expect(again.generate.mock.calls[0][0]).not.toHaveProperty('sessionName');
  });

  // A failed generation still polls 200 with status 'done'; `type` is the only failure signal.
  it('treats type: error as a failure and carries a credit exhaustion through as a notice', async () => {
    const h = await harness([
      { id: 'q1', status: 'done', type: 'error', errorCode: 'insufficient_credits', reply: 'Out of credits.' },
    ]);

    expect(await settle(generateImage(REQUEST, h.deps), 5_000)).toMatchObject({
      message: 'Out of credits.',
      notice: { kind: 'insufficient-credits' },
    });
    expect(h.fetchGenerated).not.toHaveBeenCalled();
  });

  it('rides out a single failed poll but gives up on two in a row', async () => {
    const h = await harness([DONE]);
    h.getQuest.mockReset();
    h.getQuest.mockRejectedValueOnce(new Error('network blip')).mockResolvedValueOnce(DONE);

    const promise = generateImage(REQUEST, h.deps);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toMatchObject({ media: [{ kind: 'image' }] });

    const failing = await harness([DONE]);
    failing.getQuest.mockReset();
    failing.getQuest.mockRejectedValue(new Error('gone'));
    expect(await settle(generateImage(REQUEST, failing.deps), 10_000)).toMatchObject({ message: 'gone' });
  });

  it('gives up on a quest that never settles, naming the job so it can be found later', async () => {
    const h = await harness([RUNNING]);
    expect(await settle(generateImage(REQUEST, h.deps), 200_000)).toMatchObject({
      message: expect.stringMatching(/still generating after 180s[\s\S]*job q1/),
    });
  });

  it('stops when the turn is aborted instead of polling on', async () => {
    const controller = new AbortController();
    const h = await harness([RUNNING]);
    const promise = generateImage(REQUEST, { ...h.deps, signal: controller.signal }).then(
      value => value,
      error => error as Error
    );

    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    expect(await promise).toMatchObject({ message: expect.stringMatching(/stopped/) });
  });
});
