import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises, existsSync } from 'fs';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import {
  editLocalFileTool,
  resolveEditLocalFile,
  FuzzyEditConfirmationRequiredError,
  isFuzzyEditConfirmationRequired,
} from './index';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

// Silent logger; the tool only touches context.logger and context.allowedDirectories.
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
function editTool(allowedDirectories: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return editLocalFileTool.implementation({ logger, allowedDirectories } as any);
}

const dirs: string[] = [];
async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
});

describe('editLocalFile: authorization precedes any content read (path-auth bypass / special-file DoS)', () => {
  it('resolveEditLocalFile rejects an out-of-bounds path WITHOUT reading it', async () => {
    const allowed = await freshDir('b4m-allowed-');
    const outside = await freshDir('b4m-outside-');
    const target = join(outside, 'secret.txt');
    await writeFile(target, 'top secret\n');

    // Spy AFTER the setup writes so any read of the raw path would register here.
    const readSpy = vi.spyOn(promises, 'readFile');

    await expect(
      resolveEditLocalFile({ path: target, old_string: 'top secret', new_string: 'x' }, [allowed])
    ).rejects.toThrow(/Access denied/);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('the write path rejects an out-of-bounds path WITHOUT reading it', async () => {
    const allowed = await freshDir('b4m-allowed-');
    const outside = await freshDir('b4m-outside-');
    const target = join(outside, 'secret.txt');
    await writeFile(target, 'top secret\n');

    const readSpy = vi.spyOn(promises, 'readFile');
    const tool = editTool([allowed]);

    await expect(tool.toolFn({ path: target, old_string: 'top secret', new_string: 'x' })).rejects.toThrow(
      /Access denied/
    );
    expect(readSpy).not.toHaveBeenCalled();
  });
});

describe('editLocalFile: fuzzy writes are bound to the confirmed file snapshot (TOCTOU)', () => {
  it('refuses an unconfirmed fuzzy edit, then applies it once the exact snapshot is confirmed', async () => {
    const dir = await freshDir('b4m-fuzzy-');
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n');
    const tool = editTool([dir]);
    // Trailing whitespace: not an exact substring, so it resolves via the fuzzy fallback.
    const args = { path: file, old_string: 'hello world   ', new_string: 'hi world' };

    // 1) No confirmedFuzzyHash -> refuse, carrying the resolved span and current hash.
    let thrown: unknown;
    try {
      await tool.toolFn(args);
    } catch (err) {
      thrown = err;
    }
    expect(isFuzzyEditConfirmationRequired(thrown)).toBe(true);
    const err = thrown as FuzzyEditConfirmationRequiredError;
    expect(err.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(err.diffPreview).toContain('hello world');
    // The file is untouched - a refusal never writes.
    expect(await readFile(file, 'utf-8')).toBe('hello world\n');

    // 2) A hash that does not match the current bytes is still refused.
    await expect(tool.toolFn({ ...args, confirmedFuzzyHash: 'not-the-hash' })).rejects.toSatisfy(
      isFuzzyEditConfirmationRequired
    );
    expect(await readFile(file, 'utf-8')).toBe('hello world\n');

    // 3) The exact hash the tool reported unblocks the write.
    const message = await tool.toolFn({ ...args, confirmedFuzzyHash: err.contentHash });
    expect(message).toContain('File edited successfully');
    expect(await readFile(file, 'utf-8')).toBe('hi world\n');
  });

  it('applies an exact edit with no confirmation hash (exact matches are deterministic)', async () => {
    const dir = await freshDir('b4m-exact-');
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n');
    const tool = editTool([dir]);

    const message = await tool.toolFn({ path: file, old_string: 'hello world', new_string: 'hi world' });
    expect(message).toContain('File edited successfully');
    expect(await readFile(file, 'utf-8')).toBe('hi world\n');
  });

  it('resolveEditLocalFile reports the strategy and a stable content hash without writing', async () => {
    const dir = await freshDir('b4m-resolve-');
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n');

    const exact = await resolveEditLocalFile({ path: file, old_string: 'hello world', new_string: 'hi' }, [dir]);
    expect(exact.strategy).toBeUndefined();

    const fuzzy = await resolveEditLocalFile({ path: file, old_string: 'hello world   ', new_string: 'hi' }, [dir]);
    expect(fuzzy.strategy).toBeTruthy();
    expect(fuzzy.contentHash).toBe(exact.contentHash);
    // Read-only: the file is unchanged after resolving.
    expect(await readFile(file, 'utf-8')).toBe('hello world\n');
    expect(existsSync(file)).toBe(true);
  });
});

describe('editLocalFile: the write path reuses the gate-resolved span, but always reads fresh', () => {
  it('applies the gateSnapshot span instead of re-resolving old_string/new_string when the hash still matches', async () => {
    const dir = await freshDir('b4m-reuse-');
    const file = join(dir, 'note.txt');
    const content = 'hello world\nhello world\n';
    await writeFile(file, content);
    const tool = editTool([dir]);

    // Two occurrences of old_string: a fresh resolveEdit() would throw "ambiguous
    // match". A gateSnapshot pinned to the second occurrence, with a matchedText/
    // replacement that are this call's own old_string/new_string verbatim, proves
    // the write reused the snapshot's span (skipping resolveEdit's own ambiguity
    // check) rather than re-resolving from scratch.
    const secondOccurrenceIndex = 'hello world\n'.length;
    const message = await tool.toolFn({
      path: file,
      old_string: 'hello world',
      new_string: 'hi world',
      gateSnapshot: {
        contentHash: sha256(content),
        resolvedEdit: { startIndex: secondOccurrenceIndex, matchedText: 'hello world', replacement: 'hi world' },
      },
    });

    expect(message).toContain('File edited successfully');
    expect(await readFile(file, 'utf-8')).toBe('hello world\nhi world\n');
  });

  it('still reads the file fresh and re-resolves when the gateSnapshot hash no longer matches (TOCTOU)', async () => {
    const dir = await freshDir('b4m-stale-snapshot-');
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n');
    const tool = editTool([dir]);

    const plan = await resolveEditLocalFile({ path: file, old_string: 'hello world', new_string: 'hi world' }, [dir]);
    // The file changes after the gate resolved it - the snapshot's hash is now stale.
    await writeFile(file, 'hello there\n');

    const message = await tool.toolFn({
      path: file,
      old_string: 'hello there',
      new_string: 'hi there',
      gateSnapshot: { contentHash: plan.contentHash, resolvedEdit: plan.resolvedEdit },
    });

    expect(message).toContain('File edited successfully');
    expect(await readFile(file, 'utf-8')).toBe('hi there\n');
  });

  it('rejects a gateSnapshot whose hash matches but whose resolvedEdit span is inconsistent with the real content', async () => {
    const dir = await freshDir('b4m-inconsistent-span-');
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n');
    const tool = editTool([dir]);

    // A real contentHash, paired with a resolvedEdit that was never actually resolved
    // from it - matchedText does not correspond to the real bytes at startIndex.
    // Simulates a gateSnapshot reaching the write path with a span that was never
    // computed against the current content.
    const plan = await resolveEditLocalFile({ path: file, old_string: 'hello world', new_string: 'hi world' }, [dir]);
    const mismatchedSnapshot = {
      contentHash: plan.contentHash,
      resolvedEdit: { startIndex: 0, matchedText: 'totally made up span', replacement: 'unexpected replacement' },
    };

    const message = await tool.toolFn({
      path: file,
      old_string: 'hello world',
      new_string: 'hi world',
      gateSnapshot: mismatchedSnapshot,
    });

    // The inconsistent span is rejected (matchedText is not the real bytes at
    // startIndex), so the write falls back to a genuine resolveEdit() over
    // old_string/new_string.
    expect(message).toContain('File edited successfully');
    expect(await readFile(file, 'utf-8')).toBe('hi world\n');
  });

  it("rejects a forged gateSnapshot whose span/replacement do not correspond to this call's old_string/new_string (direct-call bypass)", async () => {
    const dir = await freshDir('b4m-forged-snapshot-');
    const file = join(dir, 'note.txt');
    const content = 'hello world\n';
    await writeFile(file, content);
    const tool = editTool([dir]);

    // A real contentHash for real, currently-present bytes ('hello world' at index 0
    // passes the real-bytes check) - but old_string here is 'absent', which never
    // matched anything: this snapshot was never produced by resolving old_string/
    // new_string. A caller hitting this tool directly (bypassing the CLI wrapper's
    // gateSnapshot stripping) could forge exactly this to write arbitrary content at
    // an arbitrary offset with no old_string match at all.
    const forgedSnapshot = {
      contentHash: sha256(content),
      resolvedEdit: { startIndex: 0, matchedText: 'hello world', replacement: 'unexpected' },
    };

    await expect(
      tool.toolFn({
        path: file,
        old_string: 'absent',
        new_string: 'does not matter',
        gateSnapshot: forgedSnapshot,
      })
    ).rejects.toThrow(/not found/i);
    expect(await readFile(file, 'utf-8')).toBe(content);
  });
});
