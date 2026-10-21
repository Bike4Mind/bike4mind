import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { PostEditDiagnostics } from './PostEditDiagnostics';
import type { Diagnostic, DiagnosticsChecker } from './checkers';

const ROOT = path.resolve('/workspace/project');
const fileA = path.join(ROOT, 'src/a.ts');
const fileB = path.join(ROOT, 'src/b.ts');

const typeError = (filePath: string, message = "Type 'string' is not assignable to type 'number'."): Diagnostic => ({
  filePath,
  line: 3,
  column: 7,
  code: 'TS2322',
  message,
});

/** A checker whose calls stay pending until the test resolves them, in call order. */
function createControlledChecker() {
  const calls: Array<{ files: readonly string[]; resolve: (diagnostics: Diagnostic[]) => void }> = [];
  const check: DiagnosticsChecker = files =>
    new Promise(resolve => {
      calls.push({ files, resolve });
    });
  return { check, calls };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('PostEditDiagnostics', () => {
  it('reports errors for changed files with workspace-relative paths, then clears them', async () => {
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check: async () => [typeError(fileA)] });
    diagnostics.beginTurn();

    diagnostics.enqueue('src/a.ts');
    const report = await diagnostics.drain(1000);

    expect(report).toBe(
      [
        '[Post-edit diagnostics] Errors in files you changed. Fix them before you finish:',
        "src/a.ts:3:7 - TS2322: Type 'string' is not assignable to type 'number'.",
      ].join('\n')
    );
    expect(report).not.toContain(ROOT);
    expect(await diagnostics.drain(1000)).toBeNull();
  });

  it('only reports diagnostics that belong to the changed files', async () => {
    const elsewhere = path.join(ROOT, 'src/untouched.ts');
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check: async () => [typeError(elsewhere)] });
    diagnostics.beginTurn();

    diagnostics.enqueue(fileA);

    expect(await diagnostics.drain(1000)).toBeNull();
  });

  it('defers a busy check past a short drain and reports it on the next one', async () => {
    const { check, calls } = createControlledChecker();
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check });
    diagnostics.beginTurn();
    diagnostics.enqueue(fileA);

    expect(await diagnostics.drain(5)).toBeNull();

    calls[0].resolve([typeError(fileA)]);
    expect(await diagnostics.drain(1000)).toContain('src/a.ts:3:7');
  });

  it('never blocks enqueue on a running check', () => {
    const { check, calls } = createControlledChecker();
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check });
    diagnostics.beginTurn();

    diagnostics.enqueue(fileA);
    diagnostics.enqueue(fileB);

    expect(calls).toHaveLength(1);
  });

  it('checks a file re-edited before its check starts once, in its final state', async () => {
    const { check, calls } = createControlledChecker();
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check });
    diagnostics.beginTurn();

    diagnostics.enqueue(fileA);
    diagnostics.enqueue(fileB);
    diagnostics.enqueue(fileB);
    calls[0].resolve([]);
    await flush();

    expect(calls.map(call => call.files)).toEqual([[fileA], [fileB]]);
  });

  it('discards the in-flight result for a file re-edited mid-check and reports the re-check', async () => {
    const { check, calls } = createControlledChecker();
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check });
    diagnostics.beginTurn();

    diagnostics.enqueue(fileA);
    diagnostics.enqueue(fileA);
    calls[0].resolve([typeError(fileA, 'stale error')]);
    await flush();
    calls[1].resolve([typeError(fileA, 'fresh error')]);
    const report = await diagnostics.drain(1000);

    expect(report).toContain('fresh error');
    expect(report).not.toContain('stale error');
  });

  it('drops an already-completed result when the file is re-edited before it is reported', async () => {
    const { check, calls } = createControlledChecker();
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check });
    diagnostics.beginTurn();

    diagnostics.enqueue(fileA);
    calls[0].resolve([typeError(fileA, 'stale error')]);
    await flush();
    diagnostics.enqueue(fileA);

    expect(await diagnostics.drain(5)).toBeNull();
  });

  it('ignores edits outside a turn and drops results from a previous turn', async () => {
    const { check, calls } = createControlledChecker();
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check });

    diagnostics.enqueue(fileA);
    expect(calls).toHaveLength(0);

    diagnostics.beginTurn();
    diagnostics.enqueue(fileA);
    diagnostics.endTurn();
    diagnostics.beginTurn();
    calls[0].resolve([typeError(fileA)]);

    expect(await diagnostics.drain(1000)).toBeNull();
  });

  it('treats a throwing checker as no diagnostics', async () => {
    const diagnostics = new PostEditDiagnostics({
      workspaceRoot: ROOT,
      check: async () => {
        throw new Error('tsc exploded');
      },
    });
    diagnostics.beginTurn();
    diagnostics.enqueue(fileA);

    expect(await diagnostics.drain(1000)).toBeNull();
  });

  it('caps the report and truncates long messages', async () => {
    const many = Array.from({ length: 25 }, () => typeError(fileA, 'x'.repeat(400)));
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check: async () => many });
    diagnostics.beginTurn();
    diagnostics.enqueue(fileA);

    const lines = (await diagnostics.drain(1000))?.split('\n') ?? [];

    expect(lines).toHaveLength(1 + 20 + 1);
    expect(lines[lines.length - 1]).toBe('(+5 more)');
    expect(lines[1]).toBe(`src/a.ts:3:7 - TS2322: ${'x'.repeat(300)}...`);
  });

  it('stops waiting when the turn is aborted', async () => {
    const { check } = createControlledChecker();
    const diagnostics = new PostEditDiagnostics({ workspaceRoot: ROOT, check });
    diagnostics.beginTurn();
    diagnostics.enqueue(fileA);
    const controller = new AbortController();
    const onSettled = vi.fn();

    const drained = diagnostics.drain(60_000, controller.signal).then(onSettled);
    controller.abort();
    await drained;

    expect(onSettled).toHaveBeenCalledWith(null);
  });
});
