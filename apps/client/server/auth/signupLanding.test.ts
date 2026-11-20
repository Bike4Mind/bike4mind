import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findById, recordSignupLanding: recordOnUser } = vi.hoisted(() => ({
  findById: vi.fn(),
  recordSignupLanding: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById },
  userRepository: { recordSignupLanding: recordOnUser },
}));

import { notebookIdOfRedirect, recordSignupLanding } from './signupLanding';

const NOTEBOOK = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const NEW_USER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OWNER = 'cccccccccccccccccccccccc';
const logger = { warn: vi.fn() };

describe('notebookIdOfRedirect', () => {
  it('reads the id of a notebook route, relative or absolute', () => {
    expect(notebookIdOfRedirect(`/notebooks/${NOTEBOOK}`)).toBe(NOTEBOOK);
    expect(notebookIdOfRedirect(`/notebooks/${NOTEBOOK.toUpperCase()}?tab=chat`)).toBe(NOTEBOOK);
    expect(notebookIdOfRedirect(`https://app.example.com/notebooks/${NOTEBOOK}/`)).toBe(NOTEBOOK);
  });

  it('ignores every other target', () => {
    expect(notebookIdOfRedirect(undefined)).toBeNull();
    expect(notebookIdOfRedirect('/')).toBeNull();
    expect(notebookIdOfRedirect('/notebooks/not-an-id')).toBeNull();
    expect(notebookIdOfRedirect(`/settings/notebooks/${NOTEBOOK}`)).toBeNull();
  });
});

describe('recordSignupLanding', () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the owner of another account's notebook", async () => {
    findById.mockResolvedValue({ userId: OWNER });
    const now = new Date('2026-11-05T00:00:00Z');
    await recordSignupLanding({ userId: NEW_USER, redirectTo: `/notebooks/${NOTEBOOK}`, now }, logger);
    expect(recordOnUser).toHaveBeenCalledWith(NEW_USER, OWNER, now);
  });

  it("records nothing for the account's own notebook, a missing notebook or no notebook", async () => {
    findById.mockResolvedValueOnce({ userId: NEW_USER }).mockResolvedValueOnce(null);
    await recordSignupLanding({ userId: NEW_USER, redirectTo: `/notebooks/${NOTEBOOK}` }, logger);
    await recordSignupLanding({ userId: NEW_USER, redirectTo: `/notebooks/${NOTEBOOK}` }, logger);
    await recordSignupLanding({ userId: NEW_USER, redirectTo: '/home' }, logger);
    expect(recordOnUser).not.toHaveBeenCalled();
    expect(findById).toHaveBeenCalledTimes(2);
  });

  it('logs and swallows a read failure, since the signup already happened', async () => {
    findById.mockRejectedValue(new Error('boom'));
    await expect(
      recordSignupLanding({ userId: NEW_USER, redirectTo: `/notebooks/${NOTEBOOK}` }, logger)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('Signup landing was not recorded', {
      userId: NEW_USER,
      errorName: 'Error',
    });
  });
});
