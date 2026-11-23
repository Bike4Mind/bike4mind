import type { LocalLoop } from '@shared/localLoops';

/** A live loop for tests. */
export function testLoop(patch: Partial<LocalLoop> = {}): LocalLoop {
  return {
    id: 'loop-1',
    name: 'Docs',
    goal: 'Keep the docs right',
    stages: ['todo', 'doing', 'done'],
    stageConfig: [],
    model: 'stage-model',
    maxConcurrent: 1,
    status: 'live',
    directory: '/repo',
    approvalMode: 'auto',
    mirror: true,
    memory: { notes: '', nextAction: '' },
    errorStreak: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}
