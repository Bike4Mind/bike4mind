// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const audit = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: audit }));

import { recordModalChanges } from './recordModalChanges';

describe('recordModalChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audit.mockResolvedValue(null);
  });

  it('maps each change kind to its catalogue action', async () => {
    const req = {} as Request;
    await recordModalChanges(
      req,
      [
        { kind: 'created', id: 'a', title: 'A' },
        { kind: 'updated', id: 'b', title: 'B' },
        { kind: 'deleted', id: 'c', title: 'C' },
      ],
      'modal-tool'
    );

    expect(audit.mock.calls.map(([, input]) => input.action)).toEqual([
      'settings.modal.created',
      'settings.modal.updated',
      'settings.modal.deleted',
    ]);
    expect(audit.mock.calls[2][0]).toBe(req);
    expect(audit.mock.calls[2][1]).toMatchObject({
      target: { kind: 'settings', id: 'c', displayName: 'C' },
      details: { via: 'modal-tool' },
    });
  });

  it('records nothing for an empty change list', async () => {
    await recordModalChanges({} as Request, [], 'admin-tool');
    expect(audit).not.toHaveBeenCalled();
  });
});
