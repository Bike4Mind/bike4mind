import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { recordLakeMembershipChange } from './recordLakeMembershipChange';
import type { ManageActor } from './manageRule';

const lake = (overrides: Partial<IDataLakeDocument> = {}) =>
  ({ id: 'lake1', ...overrides }) as Pick<IDataLakeDocument, 'id' | 'organizationId'>;

const actor = (over: Partial<ManageActor> = {}): ManageActor => ({ userId: 'owner', isAdmin: false, ...over });

const adapters = (over: { record?: ReturnType<typeof vi.fn>; logger?: unknown } = {}) => {
  const record = over.record ?? vi.fn().mockResolvedValue({});
  return {
    record,
    adapters: {
      db: { lakeMembershipChangeEvents: { record } },
      logger: over.logger as never,
    },
  };
};

const recordedInput = (record: ReturnType<typeof vi.fn>) => record.mock.calls[0][0];

describe('recordLakeMembershipChange', () => {
  it('is a silent no-op when no event repository is wired', async () => {
    await expect(
      recordLakeMembershipChange(
        { actor: actor(), lake: lake(), fabFileId: 'f1', action: 'added', origin: 'person' },
        { db: {} }
      )
    ).resolves.toBeUndefined();
  });

  it('records the lake, file, action and origin as given', async () => {
    const { record, adapters: a } = adapters();
    await recordLakeMembershipChange(
      {
        actor: actor(),
        lake: lake({ organizationId: 'org-1' }),
        fabFileId: 'f1',
        action: 'removed',
        origin: 'connector',
      },
      a
    );
    expect(recordedInput(record)).toMatchObject({
      dataLakeId: 'lake1',
      organizationId: 'org-1',
      fabFileId: 'f1',
      action: 'removed',
      origin: 'connector',
    });
  });

  describe('principal', () => {
    it('is the acting user when there is one', async () => {
      const { record, adapters: a } = adapters();
      await recordLakeMembershipChange(
        { actor: actor({ userId: 'alice' }), lake: lake(), fabFileId: 'f1', action: 'added', origin: 'person' },
        a
      );
      expect(recordedInput(record)).toMatchObject({ principalKind: 'user', principalId: 'alice' });
    });

    it('is `system` for a blank actor id rather than a user with an empty id', async () => {
      const { record, adapters: a } = adapters();
      await recordLakeMembershipChange(
        { actor: actor({ userId: '' }), lake: lake(), fabFileId: 'f1', action: 'added', origin: 'connector' },
        a
      );
      expect(recordedInput(record)).toMatchObject({ principalKind: 'system', principalId: 'system' });
    });

    it('prefers a route-resolved auditPrincipal (an API key acting for a human) over the fallback', async () => {
      const { record, adapters: a } = adapters();
      await recordLakeMembershipChange(
        {
          actor: actor({
            userId: 'alice',
            auditPrincipal: { principalKind: 'apiKey', principalId: 'key_abc', onBehalfOfUserId: 'alice' },
          }),
          lake: lake(),
          fabFileId: 'f1',
          action: 'added',
          origin: 'person',
        },
        a
      );
      expect(recordedInput(record)).toMatchObject({
        principalKind: 'apiKey',
        principalId: 'key_abc',
        onBehalfOfUserId: 'alice',
      });
    });
  });

  describe('best-effort, mirroring recordLakeConfigChange', () => {
    it('swallows a failing event write and logs it through the wired logger', async () => {
      const error = vi.fn();
      const { adapters: a } = adapters({
        record: vi.fn().mockRejectedValue(new Error('mongo down')),
        logger: { error },
      });
      await expect(
        recordLakeMembershipChange(
          { actor: actor(), lake: lake(), fabFileId: 'f1', action: 'added', origin: 'person' },
          a
        )
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('audit event did not persist'),
        expect.objectContaining({ dataLakeId: 'lake1', fabFileId: 'f1', action: 'added' })
      );
    });

    it('falls back to console.error when no logger is wired, so it cannot go fully silent', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { adapters: a } = adapters({ record: vi.fn().mockRejectedValue(new Error('mongo down')) });
      await recordLakeMembershipChange(
        { actor: actor(), lake: lake(), fabFileId: 'f1', action: 'added', origin: 'person' },
        a
      );
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('audit event did not persist'), expect.anything());
      spy.mockRestore();
    });
  });
});
