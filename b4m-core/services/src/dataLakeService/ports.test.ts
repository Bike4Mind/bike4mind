import { describe, expect, it, vi } from 'vitest';
import { bestEffortAdjustOwnerStorage } from './ports';

const counter = () => ({ incrementCurrentStorage: vi.fn().mockResolvedValue(undefined) });

describe('bestEffortAdjustOwnerStorage', () => {
  it('routes each delta to its owner kind', async () => {
    const users = counter();
    const organizations = counter();

    await bestEffortAdjustOwnerStorage({ users, organizations }, [
      { owner: { type: 'org', id: 'org-1' }, bytes: -40 },
      { owner: { type: 'user', id: 'u1' }, bytes: -10 },
    ]);

    expect(organizations.incrementCurrentStorage).toHaveBeenCalledExactlyOnceWith('org-1', -40);
    expect(users.incrementCurrentStorage).toHaveBeenCalledExactlyOnceWith('u1', -10);
  });

  it('warns and skips an org delta when no org counter is wired, still applying the rest', async () => {
    const users = counter();
    const logger = { warn: vi.fn() };

    await bestEffortAdjustOwnerStorage(
      { users },
      [
        { owner: { type: 'org', id: 'org-1' }, bytes: -40 },
        { owner: { type: 'user', id: 'u1' }, bytes: -10 },
      ],
      logger
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('org-1'));
    expect(users.incrementCurrentStorage).toHaveBeenCalledExactlyOnceWith('u1', -10);
  });

  it('warns and carries on when one owner write fails', async () => {
    const users = counter();
    const organizations = { incrementCurrentStorage: vi.fn().mockRejectedValue(new Error('down')) };
    const logger = { warn: vi.fn() };

    await bestEffortAdjustOwnerStorage(
      { users, organizations },
      [
        { owner: { type: 'org', id: 'org-1' }, bytes: 5 },
        { owner: { type: 'user', id: 'u1' }, bytes: 5 },
      ],
      logger
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('org org-1'), expect.any(Error));
    expect(users.incrementCurrentStorage).toHaveBeenCalledWith('u1', 5);
  });
});
