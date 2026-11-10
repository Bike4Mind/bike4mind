import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { trackedTransport } from './progressCache';
import { tutorialProgressKey } from './tutorialKeys';
import type { TutorialTransport } from './types';

const BASE = '/api/test-tutorials';
const TUTORIAL_PROGRESS_KEY = tutorialProgressKey(BASE);

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(TUTORIAL_PROGRESS_KEY, {
    beta: { status: 'in_progress', stepId: 'setup', sessionId: 's1', moduleVersion: 2 },
  });
  let land = () => undefined as void;
  const base = {
    position: vi.fn(() => new Promise<void>(resolve => (land = resolve))),
  } as unknown as TutorialTransport;
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  return { queryClient, base, invalidate, land: () => land() };
}

describe('trackedTransport', () => {
  it('marks the module finished in the cache before the request lands', () => {
    const { queryClient, base } = setup();
    void trackedTransport(queryClient, base, BASE).position({ moduleId: 'beta', stepId: 'bridge', status: 'finished' });
    expect(queryClient.getQueryData(TUTORIAL_PROGRESS_KEY)).toEqual({
      beta: { status: 'finished', stepId: 'bridge', sessionId: 's1', moduleVersion: 2 },
    });
  });

  it('refetches the progress once the request has landed, and not before', async () => {
    const { queryClient, base, invalidate, land } = setup();
    const saving = trackedTransport(queryClient, base, BASE).position({
      moduleId: 'beta',
      stepId: 'bridge',
      status: 'finished',
    });
    expect(invalidate).not.toHaveBeenCalled();
    land();
    await saving;
    expect(invalidate).toHaveBeenCalledWith({ queryKey: TUTORIAL_PROGRESS_KEY });
  });

  it('adds no entry for a module the cache does not hold', () => {
    const { queryClient, base } = setup();
    void trackedTransport(queryClient, base, BASE).position({ moduleId: 'alpha', stepId: 'intro', status: 'left' });
    expect(queryClient.getQueryData<Record<string, unknown>>(TUTORIAL_PROGRESS_KEY)).not.toHaveProperty('alpha');
  });
});
