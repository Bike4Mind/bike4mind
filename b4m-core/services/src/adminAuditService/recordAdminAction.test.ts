import { describe, expect, it, vi } from 'vitest';
import type { AuditActor, AuditContext, AuditEntry, AuditTarget, NewAdminAuditEntry } from '@bike4mind/common';
import { recordAdminAction, type RecordAdminActionInput } from './recordAdminAction';

const actor: AuditActor = { kind: 'user', scope: 'platform', userId: 'u1', name: 'Admin', wasAdmin: true };
const context: AuditContext = { source: 'admin_ui' };
const userTarget: AuditTarget = { kind: 'user', id: 'u2', displayName: 'User' };
const orgTarget: AuditTarget = { kind: 'organization', id: 'org1', displayName: 'Org' };

const baseInput = (overrides: Partial<RecordAdminActionInput> = {}): RecordAdminActionInput => ({
  action: 'org.credits.granted',
  actor,
  target: orgTarget,
  summary: 'granted',
  context,
  ...overrides,
});

const setup = () => {
  const append = vi.fn(async (entry: NewAdminAuditEntry): Promise<AuditEntry> => ({
    ...entry,
    id: 'e1',
    source: 'admin',
  }));
  const logger = { error: vi.fn() };
  return { append, logger, adapters: { db: { adminAuditLog: { append } }, logger } };
};

describe('recordAdminAction', () => {
  it('takes category and severity from the catalogue, ignoring smuggled values', async () => {
    const { append, adapters } = setup();
    const smuggled = { ...baseInput(), category: 'support', severity: 'critical' } as RecordAdminActionInput;
    await recordAdminAction(smuggled, adapters);
    expect(append.mock.calls[0][0]).toMatchObject({ category: 'credits', severity: 'notice' });
  });

  it('defaults organizationId to the target id for organization targets only', async () => {
    const { append, adapters } = setup();
    await recordAdminAction(baseInput(), adapters);
    await recordAdminAction(baseInput({ target: userTarget }), adapters);
    await recordAdminAction(baseInput({ target: userTarget, organizationId: 'org9' }), adapters);
    expect(append.mock.calls.map(([entry]) => entry.organizationId)).toEqual(['org1', undefined, 'org9']);
  });

  it('redacts secrets nested in details and changes', async () => {
    const { append, adapters } = setup();
    await recordAdminAction(
      baseInput({
        details: { client: { clientSecret: 's' }, items: [{ token: 't' }] },
        changes: [
          { field: 'config', before: { apiKey: 'a' }, after: { apiKey: 'b' } },
          { field: 'clientSecret', before: 'old', after: 'new' },
        ],
      }),
      adapters
    );
    const stored = append.mock.calls[0][0];
    expect(stored.details).toEqual({ client: { clientSecret: '[REDACTED]' }, items: [{ token: '[REDACTED]' }] });
    expect(stored.changes).toEqual([
      { field: 'config', before: { apiKey: '[REDACTED]' }, after: { apiKey: '[REDACTED]' } },
      { field: 'clientSecret', before: '[REDACTED]', after: '[REDACTED]' },
    ]);
  });

  it('rethrows the repository error for strict actions', async () => {
    const { append, adapters } = setup();
    const failure = new Error('db down');
    append.mockRejectedValueOnce(failure);
    await expect(recordAdminAction(baseInput(), adapters)).rejects.toBe(failure);
  });

  it('logs and returns null for bestEffort actions', async () => {
    const { append, logger, adapters } = setup();
    const failure = new Error('db down');
    append.mockRejectedValueOnce(failure);
    const result = await recordAdminAction(baseInput({ action: 'org.seats.changed' }), adapters);
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('[ADMIN_AUDIT_WRITE_FAILED]', {
      action: 'org.seats.changed',
      error: failure,
    });
  });

  it('falls back to console.error without a logger', async () => {
    const { append } = setup();
    append.mockRejectedValueOnce(new Error('x'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await recordAdminAction(baseInput({ action: 'org.seats.changed' }), {
      db: { adminAuditLog: { append } },
    });
    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith(
      '[ADMIN_AUDIT_WRITE_FAILED]',
      expect.objectContaining({ action: 'org.seats.changed' })
    );
    spy.mockRestore();
  });
});
