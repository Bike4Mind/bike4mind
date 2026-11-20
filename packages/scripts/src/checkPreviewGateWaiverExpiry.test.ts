import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const workflow = readFileSync(
  new URL('../../../.github/workflows/sst-infra-preview-gate.yml', import.meta.url),
  'utf8'
);
const start = workflow.indexOf('      - name: Expire preview waiver on push');
const end = workflow.indexOf('      - name: Require a preview', start);
const script = workflow.slice(start, end).split('          script: |\n')[1];
if (start === -1 || end === -1 || script === undefined) throw new Error('Preview waiver expiry step is missing');

type LabelRemoval = { owner: string; repo: string; issue_number: number; name: string };
type RemoveLabel = (parameters: LabelRemoval) => Promise<unknown>;
type Context = {
  repo: { owner: string; repo: string };
  payload: { action: string; pull_request: { number: number; labels: { name: string }[] } };
};
type GitHub = { rest: { issues: { removeLabel: RemoveLabel } } };
type Core = { notice: (message: string) => void };

// Execute the workflow's actual script against an in-memory API, without a checkout or network.
const expireWaiver = compileFunction(`return (async () => {\n${script}\n})()`, ['context', 'github', 'core']) as (
  context: Context,
  github: GitHub,
  core: Core
) => Promise<void>;

function fixture(action: string, labels = ['skip-preview']) {
  const context: Context = {
    repo: { owner: 'example', repo: 'repo' },
    payload: { action, pull_request: { number: 42, labels: labels.map(name => ({ name })) } },
  };
  const removeLabel = vi.fn<RemoveLabel>().mockResolvedValue({});
  const github: GitHub = { rest: { issues: { removeLabel } } };
  const core: Core = { notice: vi.fn<(message: string) => void>() };
  return { context, github, core, removeLabel };
}

describe('preview waiver expiry', () => {
  it('removes the waiver on a push before the gate reads current labels', async () => {
    const { context, github, core, removeLabel } = fixture('synchronize');
    await expireWaiver(context, github, core);
    expect(removeLabel).toHaveBeenCalledExactlyOnceWith({
      owner: 'example',
      repo: 'repo',
      issue_number: 42,
      name: 'skip-preview',
    });
    expect(start).toBeLessThan(workflow.indexOf('          preview_labels='));
  });

  it.each(['opened', 'labeled', 'unlabeled'])('preserves a waiver on %s events', async action => {
    const { context, github, core, removeLabel } = fixture(action);
    await expireWaiver(context, github, core);
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('does not remove labels with similar names', async () => {
    const { context, github, core, removeLabel } = fixture('synchronize', ['no-skip-preview', 'skip-preview-later']);
    await expireWaiver(context, github, core);
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it('accepts a waiver that was already removed', async () => {
    const { context, github, core, removeLabel } = fixture('synchronize');
    removeLabel.mockRejectedValue({ status: 404 });
    await expect(expireWaiver(context, github, core)).resolves.toBeUndefined();
  });

  it.each([403, 500])('stops the gate when label removal fails with %s', async status => {
    const { context, github, core, removeLabel } = fixture('synchronize');
    const error = { status };
    removeLabel.mockRejectedValue(error);
    await expect(expireWaiver(context, github, core)).rejects.toBe(error);
  });

  it('uses a trusted metadata-only workflow for label writes on fork PRs', () => {
    expect(workflow).toMatch(/^ {2}pull_request_target:$/m);
    expect(workflow).toMatch(/^ {2}pull-requests: write$/m);
    expect(workflow).not.toContain('actions/checkout');
  });

  it('keeps a path-scoped PR trigger to validate changes to the required workflow itself', () => {
    expect(workflow).toMatch(
      /^ {2}pull_request:\n {4}types: .+\n {4}paths: \['\.github\/workflows\/sst-infra-preview-gate\.yml'\]/m
    );
    expect(workflow).toContain("if: github.event_name == 'pull_request_target' || github.event_name == 'pull_request'");
  });
});
