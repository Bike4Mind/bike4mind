import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_DRAFT_MAX_AGE_MS,
  COMPOSER_DRAFT_MAX_LENGTH,
  COMPOSER_DRAFT_SAVE_DELAY_MS,
  COMPOSER_DRAFTS_TOTAL_MAX_LENGTH,
} from '@shared/composerDrafts';
import { ComposerDraftStore } from './ComposerDraftStore';

async function fileIn(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'composer-drafts-')), 'composer-drafts.json');
}

/** Reads the file until it holds `expected` or the write had ample turns (setImmediate is not faked). */
async function onDiskSoon(path: string, expected: Record<string, string>): Promise<unknown> {
  let drafts: unknown = undefined;
  for (let turn = 0; turn < 200; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
    drafts = await new ComposerDraftStore(path).load();
    if (JSON.stringify(drafts) === JSON.stringify(expected)) break;
  }
  return drafts;
}

const stored = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

describe('ComposerDraftStore', () => {
  it('starts empty when there is no file, or a corrupt one', async () => {
    const path = await fileIn();
    expect(await new ComposerDraftStore(path).load()).toEqual({});
    await writeFile(path, '{not json');
    expect(await new ComposerDraftStore(path).load()).toEqual({});
  });

  it('saves a draft to an owner-only file and restores it on the next load', async () => {
    const path = await fileIn();
    const store = new ComposerDraftStore(path, () => 1000);
    await store.load();
    await store.set('s1', 'half a prompt');
    await store.set('s2', 'another');
    await store.flush();

    expect(await new ComposerDraftStore(path, () => 2000).load()).toEqual({ s1: 'half a prompt', s2: 'another' });
    expect(await stored(path)).toEqual({
      drafts: { s1: { text: 'half a prompt', updatedAt: 1000 }, s2: { text: 'another', updatedAt: 1000 } },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('keeps each keystroke in memory at once but writes the file only after a pause in typing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const path = await fileIn();
      const store = new ComposerDraftStore(path, Date.now, 500);
      await store.load();
      void store.set('s1', 'h');
      vi.advanceTimersByTime(400);
      void store.set('s1', 'he');
      vi.advanceTimersByTime(499);
      expect(store.all()).toEqual({ s1: 'he' });
      expect(await new ComposerDraftStore(path).load()).toEqual({});
      vi.advanceTimersByTime(1);
      await store.flush();
      expect(await new ComposerDraftStore(path).load()).toEqual({ s1: 'he' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes during typing that never pauses, at most the max wait after the first unsaved change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const path = await fileIn();
      const store = new ComposerDraftStore(path, Date.now, 500, 2000);
      await store.load();
      for (let keystroke = 1; keystroke <= 4; keystroke += 1) {
        void store.set('s1', 'x'.repeat(keystroke));
        vi.advanceTimersByTime(400);
      }
      // 1600 ms in: every pause was shorter than the delay, so nothing is written yet.
      expect(await new ComposerDraftStore(path).load()).toEqual({});
      void store.set('s1', 'xxxxx');
      // 2000 ms in, 400 ms after the last keystroke: only the max wait can have fired.
      vi.advanceTimersByTime(400);
      expect(await onDiskSoon(path, { s1: 'xxxxx' })).toEqual({ s1: 'xxxxx' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes a draft typed just before a quit, while its save is still waiting on the pause', async () => {
    const path = await fileIn();
    const store = new ComposerDraftStore(path, Date.now, 60_000);
    await store.load();
    void store.set('s1', 'typed, then quit at once');
    store.flushSync();
    expect(await new ComposerDraftStore(path).load()).toEqual({ s1: 'typed, then quit at once' });
  });

  it('clears a draft when it is emptied, made blank or forgotten', async () => {
    const path = await fileIn();
    const store = new ComposerDraftStore(path);
    await store.load();
    await store.set('s1', 'one');
    await store.set('s2', 'two');
    await store.set('s3', 'three');

    await store.set('s1', '');
    await store.set('s2', '  \n ');
    await store.forget('s3');

    expect(store.all()).toEqual({});
    expect(await new ComposerDraftStore(path).load()).toEqual({});
  });

  it('does not keep a draft longer than the per-draft limit, so a stale shorter one cannot come back', async () => {
    const store = new ComposerDraftStore(await fileIn());
    await store.load();
    await store.set('s1', 'short');
    await store.set('s1', 'x'.repeat(COMPOSER_DRAFT_MAX_LENGTH + 1));
    expect(store.all()).toEqual({});
  });

  it('drops the least recently edited drafts once the total limit is passed', async () => {
    let now = 0;
    const store = new ComposerDraftStore(await fileIn(), () => now);
    await store.load();
    const fifth = COMPOSER_DRAFTS_TOTAL_MAX_LENGTH / 5;
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      now += 1;
      await store.set(id, id.repeat(fifth));
    }
    expect(Object.keys(store.all())).toHaveLength(5);
    // Editing the oldest makes it the most recent, so the next one along is the first to go.
    now += 1;
    await store.set('a', 'A'.repeat(fifth));
    now += 1;
    await store.set('f', 'over the limit');

    expect(Object.keys(store.all()).sort()).toEqual(['a', 'c', 'd', 'e', 'f']);
  });

  it('prunes drafts past the age limit when loading, and writes the pruned file back', async () => {
    const path = await fileIn();
    const now = 10 * COMPOSER_DRAFT_MAX_AGE_MS;
    await writeFile(
      path,
      JSON.stringify({
        drafts: {
          fresh: { text: 'keep me', updatedAt: now - 1000 },
          stale: { text: 'old', updatedAt: now - COMPOSER_DRAFT_MAX_AGE_MS - 1 },
          blank: { text: '   ', updatedAt: now },
        },
      })
    );
    const store = new ComposerDraftStore(path, () => now);
    expect(await store.load()).toEqual({ fresh: 'keep me' });
    await store.set('fresh', 'keep me');
    expect(await stored(path)).toEqual({ drafts: { fresh: { text: 'keep me', updatedAt: now - 1000 } } });
  });

  it('flushes synchronously on quit, but never before the file has been read', async () => {
    const path = await fileIn();
    await writeFile(path, JSON.stringify({ drafts: { s1: { text: 'on disk', updatedAt: Date.now() } } }));

    new ComposerDraftStore(path).flushSync();
    expect(await new ComposerDraftStore(path).load()).toEqual({ s1: 'on disk' });

    const store = new ComposerDraftStore(path);
    await store.load();
    void store.set('s2', 'typed just before quit');
    store.flushSync();
    expect(await new ComposerDraftStore(path).load()).toEqual({ s1: 'on disk', s2: 'typed just before quit' });
  });

  it('leaves a corrupt file byte-identical through load and quit', async () => {
    const path = await fileIn();
    await writeFile(path, '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = new ComposerDraftStore(path);
      expect(await store.load()).toEqual({});
      store.flushSync();
      await store.set('s1', 'typed after a failed read');
      await store.flush();
      store.flushSync();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(await readFile(path, 'utf8')).toBe('{not json');
  });

  it('does not rewrite the file on a plain launch and quit', async () => {
    const path = await fileIn();
    const contents = `{ "drafts": { "s1": { "text": "on disk", "updatedAt": ${Date.now()} } } }\n`;
    await writeFile(path, contents);
    const store = new ComposerDraftStore(path);
    await store.load();
    store.flushSync();
    expect(await readFile(path, 'utf8')).toBe(contents);
  });

  it('keeps a draft exactly at the age limit and drops one a millisecond older', async () => {
    const path = await fileIn();
    const now = 10 * COMPOSER_DRAFT_MAX_AGE_MS;
    await writeFile(
      path,
      JSON.stringify({
        drafts: {
          edge: { text: 'at the limit', updatedAt: now - COMPOSER_DRAFT_MAX_AGE_MS },
          over: { text: 'just past it', updatedAt: now - COMPOSER_DRAFT_MAX_AGE_MS - 1 },
        },
      })
    );
    expect(await new ComposerDraftStore(path, () => now).load()).toEqual({ edge: 'at the limit' });
  });

  it('waits COMPOSER_DRAFT_SAVE_DELAY_MS by default before writing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const path = await fileIn();
      const store = new ComposerDraftStore(path);
      await store.load();
      void store.set('s1', 'typing');
      vi.advanceTimersByTime(COMPOSER_DRAFT_SAVE_DELAY_MS - 1);
      expect(await new ComposerDraftStore(path).load()).toEqual({});
      vi.advanceTimersByTime(1);
      await store.flush();
      expect(await new ComposerDraftStore(path).load()).toEqual({ s1: 'typing' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes at quit while an async save of the latest text is still in flight', async () => {
    const path = await fileIn();
    const store = new ComposerDraftStore(path, () => 1000);
    await store.load();
    void store.set('s1', 'latest text');
    void store.flush();
    store.flushSync();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      drafts: { s1: { text: 'latest text', updatedAt: 1000 } },
    });
    await store.flush();
    expect(await stored(path)).toEqual({ drafts: { s1: { text: 'latest text', updatedAt: 1000 } } });
  });

  it('keeps a sent draft off the disk when quit arrives while its clearing is still being written', async () => {
    const path = await fileIn();
    const store = new ComposerDraftStore(path, () => 1000);
    await store.load();
    await store.set('s1', 'about to send');
    await store.flush();
    void store.forget('s1');
    store.flushSync();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ drafts: {} });
  });
});
