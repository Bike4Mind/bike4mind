import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { update } from './update';

describe('projectService - update (narrowed writes)', () => {
  const USER_ID = 'user-1';
  const PROJECT_ID = 'project-1';

  let db: { projects: { findByIdAndUserId: Mock; update: Mock } };
  // The stub db implements only the repository methods this service calls.
  const adapters = () => ({ db }) as unknown as Parameters<typeof update>[2];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    db = {
      projects: {
        findByIdAndUserId: vi.fn(async () => ({
          id: PROJECT_ID,
          userId: USER_ID,
          name: 'old name',
          description: 'old description',
        })),
        update: vi.fn(async () => undefined),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes name and description with updatedAt', async () => {
    await update(USER_ID, { id: PROJECT_ID, name: 'new name', description: 'new description' }, adapters());

    expect(db.projects.update).toHaveBeenCalledTimes(1);
    expect(db.projects.update.mock.calls[0][0]).toStrictEqual({
      id: PROJECT_ID,
      name: 'new name',
      description: 'new description',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('omits description when only name is given', async () => {
    await update(USER_ID, { id: PROJECT_ID, name: 'new name' }, adapters());

    expect(db.projects.update).toHaveBeenCalledTimes(1);
    expect(db.projects.update.mock.calls[0][0]).toStrictEqual({
      id: PROJECT_ID,
      name: 'new name',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });

  it('strips unknown keys such as userId before writing', async () => {
    await update(
      USER_ID,
      { id: PROJECT_ID, name: 'new name', userId: 'attacker' } as Parameters<typeof update>[1],
      adapters()
    );

    expect(db.projects.update).toHaveBeenCalledTimes(1);
    expect(db.projects.update.mock.calls[0][0]).toStrictEqual({
      id: PROJECT_ID,
      name: 'new name',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
  });
});
