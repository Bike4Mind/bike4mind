import { describe, expect, it, vi } from 'vitest';
import type { HostInstallProgressEvent, HostInstallResult } from '@shared/hostConnection';
import { createHostOperations } from './hostOperations';

function setup(result: HostInstallResult | Error) {
  let emit: (event: HostInstallProgressEvent) => void = () => undefined;
  const stop = vi.fn();
  const settle = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const operations = createHostOperations(() => ({
    install: settle,
    update: settle,
    onInstallProgress: listener => {
      emit = listener;
      return stop;
    },
  }));
  return { operations, emit: (event: HostInstallProgressEvent) => emit(event), stop, settle };
}

describe('host operations', () => {
  it('runs an install, tracks its progress, and goes idle when it lands', async () => {
    const { operations, emit } = setup({ status: 'installed', version: '2', restarted: false });
    const unsubscribe = operations.subscribe(() => undefined);
    const done = operations.install('h');
    expect(operations.get('h')).toMatchObject({ status: 'running', kind: 'install', progress: null });
    emit({ hostId: 'h', progress: { phase: 'verifying' } });
    expect(operations.get('h')).toMatchObject({ progress: { phase: 'verifying' } });
    await done;
    expect(operations.get('h').status).toBe('idle');
    unsubscribe();
  });

  it('parks an update that would interrupt work until the user agrees', async () => {
    const { operations, settle } = setup({ status: 'confirmationRequired', work: { kind: 'unknown' } });
    await operations.update('h', false);
    expect(operations.get('h')).toEqual({ status: 'needsConfirmation', work: { kind: 'unknown' } });
    expect(settle).toHaveBeenCalledWith('h', { force: false });
    operations.dismiss('h');
    expect(operations.get('h').status).toBe('idle');
  });

  it('keeps the failure for display, whether returned or thrown', async () => {
    const failed = setup({
      status: 'failed',
      failure: { kind: 'installFailed', detail: 'no space', stderrTail: 'disk full' },
    });
    await failed.operations.install('h');
    expect(failed.operations.get('h')).toMatchObject({ status: 'failed', failure: { stderrTail: 'disk full' } });
    const thrown = setup(new Error('bridge down'));
    await thrown.operations.install('h');
    expect(thrown.operations.get('h')).toMatchObject({ status: 'failed', failure: { detail: 'bridge down' } });
  });

  it('ignores a second install while one runs', async () => {
    const { operations, settle } = setup({ status: 'upToDate', version: '2' });
    const first = operations.install('h');
    await operations.install('h');
    await first;
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('listens for progress only while something is subscribed', () => {
    const { operations, stop } = setup({ status: 'upToDate', version: '2' });
    const unsubscribe = operations.subscribe(() => undefined);
    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
