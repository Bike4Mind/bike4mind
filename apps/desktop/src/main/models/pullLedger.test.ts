import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelPull } from '@shared/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityLedger } from '../chat/capabilities/CapabilityLedger';
import { PullLedger } from './pullLedger';
import type { StartedPull } from './ModelHubService';

const directories: string[] = [];

afterEach(async () =>
  Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
);

const STARTED: StartedPull = {
  key: 'qwen/qwen3-0.6b-gguf#qwen3-0.6b-q8_0',
  serverId: 'local',
  serverName: 'This computer',
  ref: 'hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0',
  label: 'Q8_0',
  sizeBytes: 639_446_688,
};

function pull(phase: ModelPull['phase'], key = STARTED.key): ModelPull {
  return {
    key,
    serverId: 'local',
    serverName: 'This computer',
    repo: 'Qwen/Qwen3-0.6B-GGUF',
    buildId: 'qwen3-0.6b-q8_0',
    label: 'Q8_0',
    ref: STARTED.ref,
    phase,
    completedBytes: 0,
    totalBytes: null,
    expectedBytes: STARTED.sizeBytes,
    error: null,
  };
}

async function setup(initial: ModelPull[] = [pull('downloading')]) {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-pull-ledger-'));
  directories.push(directory);
  const path = join(directory, 'capability-ledger.json');
  let pulls = initial;
  const warn = vi.fn();
  const ledger = new CapabilityLedger(path);
  const recorder = new PullLedger(ledger, () => pulls, warn);
  return { ledger, recorder, warn, path, setPulls: (next: ModelPull[]) => (pulls = next) };
}

describe('PullLedger', () => {
  it('records an approved download as a desktop grant and its use, with size, server and folder', async () => {
    const { ledger, recorder } = await setup();
    await recorder.started(STARTED, { path: '/home/me/.ollama/models', source: 'runtime', freeBytes: 1 });

    const { grants, audit } = await ledger.state();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      subject: { kind: 'desktop-user' },
      capability: 'model-download',
      source: 'approval',
      scope: {
        kind: 'model-pull',
        value: STARTED.key,
        model: 'hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0',
        server: 'This computer',
        bytes: STARTED.sizeBytes,
        path: '/home/me/.ollama/models',
        pathSource: 'runtime',
      },
    });
    expect(grants[0].revokedAt).toBeUndefined();
    expect(audit.map(event => event.type)).toEqual(['use', 'grant']);
  });

  it('records a guessed folder as a guess, and no folder when none is known', async () => {
    const guessed = await setup();
    await guessed.recorder.started(STARTED, {
      path: '/usr/share/ollama/.ollama/models',
      source: 'default',
      freeBytes: 1,
    });
    expect((await guessed.ledger.state()).grants[0].scope).toMatchObject({
      path: '/usr/share/ollama/.ollama/models',
      pathSource: 'default',
    });

    const unknown = await setup();
    await unknown.recorder.started(STARTED, { path: null, source: null, freeBytes: null });
    const scope = (await unknown.ledger.state()).grants[0].scope;
    expect(scope).not.toHaveProperty('path');
    expect(scope).not.toHaveProperty('pathSource');
  });

  it('retries a revoke that failed when the downloads next change', async () => {
    const { ledger, recorder, warn } = await setup();
    await recorder.started(STARTED, null);
    await recorder.settled([pull('downloading')]);
    const revoke = vi.spyOn(ledger, 'revokeMatching').mockRejectedValueOnce(new Error('disk full'));
    await recorder.settled([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect((await ledger.state()).grants[0].revokedAt).toBeUndefined();

    await recorder.settled([]);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect((await ledger.state()).grants[0].revokedAt).toBeDefined();
  });

  it('keeps the grant while the download runs or pauses, and revokes it once it finishes or fails', async () => {
    const { ledger, recorder } = await setup();
    await recorder.started(STARTED, null);
    await recorder.settled([pull('downloading')]);
    await recorder.settled([pull('paused')]);
    expect((await ledger.state()).grants[0].revokedAt).toBeUndefined();

    await recorder.settled([pull('failed')]);
    const { grants, audit } = await ledger.state();
    expect(grants[0].revokedAt).toBeDefined();
    expect(audit[0]).toMatchObject({ type: 'revoke', grantId: grants[0].id });
  });

  it('revokes the grant of a download that ended while an earlier revoke was still being written', async () => {
    const { ledger, recorder } = await setup();
    await recorder.started(STARTED, null);
    const first = recorder.settled([pull('downloading')]);
    const second = recorder.settled([]);
    await Promise.all([first, second]);
    expect((await ledger.state()).grants[0].revokedAt).toBeDefined();
  });

  it('revokes a grant written after its download already ended', async () => {
    const { ledger, recorder, setPulls } = await setup();
    setPulls([]);
    await recorder.started(STARTED, null);
    expect((await ledger.state()).grants[0].revokedAt).toBeDefined();
  });

  it('closes download grants left open by a previous run', async () => {
    const first = await setup();
    await first.recorder.started(STARTED, null);
    const again = new PullLedger(new CapabilityLedger(first.path), () => [], vi.fn());
    await again.retireAll();
    expect((await new CapabilityLedger(first.path).state()).grants[0].revokedAt).toBeDefined();
  });

  it('never fails a download over a ledger it cannot write', async () => {
    const { ledger, recorder, warn } = await setup();
    vi.spyOn(ledger, 'grant').mockRejectedValue(new Error('disk full'));
    await expect(recorder.started(STARTED, null)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});
