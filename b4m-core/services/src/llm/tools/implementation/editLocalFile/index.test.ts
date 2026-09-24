import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises, existsSync } from 'fs';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  editLocalFileTool,
  resolveEditLocalFile,
  FuzzyEditConfirmationRequiredError,
  isFuzzyEditConfirmationRequired,
} from './index';

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
    await writeFile(file, 'hello world\n');
    const tool = editTool([dir]);

    const plan = await resolveEditLocalFile({ path: file, old_string: 'hello world', new_string: 'hi world' }, [dir]);

    // A fresh resolveEdit() on this old_string/new_string pair would produce a
    // different replacement - passing the ORIGINAL resolvedEdit alongside a matching
    // contentHash proves the write reused it rather than re-resolving from scratch.
    const message = await tool.toolFn({
      path: file,
      old_string: 'hello world',
      new_string: 'this replacement would land if it were re-resolved',
      gateSnapshot: { contentHash: plan.contentHash, resolvedEdit: plan.resolvedEdit },
    });

    expect(message).toContain('File edited successfully');
    expect(await readFile(file, 'utf-8')).toBe('hi world\n');
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

  it('rejects a gateSnapshot whose hash matches but whose resolvedEdit span is forged/inconsistent with the real content', async () => {
    const dir = await freshDir('b4m-forged-span-');
    const file = join(dir, 'note.txt');
    await writeFile(file, 'hello world\n');
    const tool = editTool([dir]);

    // A real contentHash (as a caller with independent read access could compute),
    // paired with a resolvedEdit that was never actually resolved from it - matchedText
    // does not correspond to the real bytes at startIndex. Simulates a forged
    // gateSnapshot reaching the write path with no editPlan ever computed for it.
    const plan = await resolveEditLocalFile({ path: file, old_string: 'hello world', new_string: 'hi world' }, [dir]);
    const forged = {
      contentHash: plan.contentHash,
      resolvedEdit: { startIndex: 0, matchedText: 'totally made up span', replacement: 'PWNED' },
    };

    const message = await tool.toolFn({
      path: file,
      old_string: 'hello world',
      new_string: 'hi world',
      gateSnapshot: forged,
    });

    // The forged span is rejected (matchedText is not the real bytes at startIndex),
    // so the write falls back to a genuine resolveEdit() over old_string/new_string.
    expect(message).toContain('File edited successfully');
    expect(await readFile(file, 'utf-8')).toBe('hi world\n');
  });
});
