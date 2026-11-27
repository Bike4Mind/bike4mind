import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from './ApprovalGate';
import { shellApproval } from './shellTools';
import type { ApprovalPrompt, ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveLoginShellVariables: async () => ({}),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

/** The shape a shell card offers for "Allow in this chat", and what it covers once given. */
describe('shellApproval command shape', () => {
  let project: string;
  let context: ToolContext;

  beforeAll(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-shape-shell-')));
    context = { roots: [project], workingDirectory: project } as unknown as ToolContext;
  });
  afterAll(() => rm(project, { recursive: true, force: true }));

  const approve = (command: string, cwd = project): Promise<ApprovalPrompt> =>
    shellApproval('bash_execute', { command, cwd }, context);

  async function allowInChat(gate: ApprovalGate, prompt: ApprovalPrompt): Promise<void> {
    const controller = new AbortController();
    let approvalId = '';
    const settled = gate.request('s', prompt.key, controller.signal, id => (approvalId = id), {
      ...(prompt.always ? { always: prompt.always } : {}),
      remember: () => !prompt.irreversible && !prompt.allowOnce,
    });
    gate.resolve(approvalId, { decision: 'always' });
    await settled;
  }

  const covered = (gate: ApprovalGate, prompt: ApprovalPrompt) =>
    !!prompt.always?.shape && gate.coversShape('s', prompt.always.namespace, prompt.always.shape);

  const unfollowed = 'tmp=$(mktemp) && git diff > "$tmp" && wc -l "$tmp"';

  it('offers a shape for a command the scan cannot follow, keyed to its folder', async () => {
    const prompt = await approve(unfollowed);
    expect(prompt.unchecked).toBe(true);
    expect(prompt.always?.shape).toBe(`${project}\x00tmp=$(mktemp) && git diff > "\x00tmp\x00" && wc -l "\x00tmp\x00"`);
  });

  it('covers the same command however its variables are spelled once allowed in this chat', async () => {
    const gate = new ApprovalGate();
    await allowInChat(gate, await approve(unfollowed));
    expect(covered(gate, await approve('tmp=$(mktemp) && git diff > "${tmp}" && wc -l "${tmp}"'))).toBe(true);
    expect(covered(gate, await approve('tmp=$(mktemp) && git diff > "$tmp" && wc -l "$TMPDIR"'))).toBe(false);
  });

  it('does not cover the same command with another structure or program', async () => {
    const gate = new ApprovalGate();
    await allowInChat(gate, await approve(unfollowed));
    for (const other of [
      'tmp=$(mktemp) && git diff > "$tmp" ; wc -l "$tmp"',
      'tmp=$(mktemp) && git diff > "$tmp" && cat "$tmp"',
      'tmp=$(mktemp) && git diff > "$tmp" 2> err && wc -l "$tmp"',
    ]) {
      expect(covered(gate, await approve(other))).toBe(false);
    }
  });

  it('offers no shape for a floor ask, so none can cover one', async () => {
    for (const command of [
      'rm -rf "$(mktemp -d)/$X"',
      'cat ~/.ssh/id_rsa "$X" | wc -c',
      'git config core.hooksPath "$X"',
    ]) {
      const prompt = await approve(command);
      expect(prompt.askInAuto).toBe(true);
      expect(prompt.always?.shape).toBeUndefined();
    }
  });

  it('offers no shape for a command the scan follows: its prefix patterns cover it', async () => {
    expect((await approve('git status')).always?.shape).toBeUndefined();
    expect((await approve('echo "$HOME"')).always?.shape).toBeUndefined();
  });
});
