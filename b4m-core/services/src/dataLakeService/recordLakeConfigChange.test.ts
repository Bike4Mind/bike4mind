import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IDataLakeDocument, ILakeConfigFieldChange, RecordLakeConfigChangeInput } from '@bike4mind/common';
import { LAKE_CONFIG_AUDIT_RETENTION_DEFAULT_DAYS, LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { recordLakeConfigChange } from './recordLakeConfigChange';
import type { LakeGrant, ManageActor } from './manageRule';

const lake = (overrides: Partial<IDataLakeDocument> = {}) =>
  ({ id: 'lake1', createdByUserId: 'owner', ...overrides }) as IDataLakeDocument;

const actor = (over: Partial<ManageActor> = {}): ManageActor => ({ userId: 'owner', isAdmin: false, ...over });

const change: ILakeConfigFieldChange = { field: 'name', kind: 'literal', before: 'a', after: 'b' };

const adapters = (over: { record?: ReturnType<typeof vi.fn>; adminSettings?: unknown; logger?: unknown } = {}) => {
  const record = over.record ?? vi.fn().mockResolvedValue({});
  return {
    record,
    adapters: {
      db: {
        lakeConfigChangeEvents: { record },
        ...(over.adminSettings === undefined ? {} : { adminSettings: over.adminSettings as never }),
      },
      logger: over.logger as never,
    },
  };
};

const recordedInput = (record: ReturnType<typeof vi.fn>): RecordLakeConfigChangeInput => record.mock.calls[0][0];

describe('recordLakeConfigChange', () => {
  it('records nothing for an empty change set, so callers need no guard of their own', async () => {
    const { record, adapters: a } = adapters();
    await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [] }, a);
    expect(record).not.toHaveBeenCalled();
  });

  it('is a silent no-op when no event repository is wired', async () => {
    // Scripts and migrations reach these services without an audit trail; that must not throw.
    await expect(
      recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, { db: {} })
    ).resolves.toBeUndefined();
  });

  it('records the lake org, the action, and the changes as given', async () => {
    const { record, adapters: a } = adapters();
    await recordLakeConfigChange(
      { actor: actor(), lake: lake({ organizationId: 'org-1' }), action: 'visibility', changes: [change] },
      a
    );
    expect(recordedInput(record)).toMatchObject({
      dataLakeId: 'lake1',
      organizationId: 'org-1',
      action: 'visibility',
      changes: [change],
    });
  });

  describe('principal', () => {
    it('is the acting user when there is one', async () => {
      const { record, adapters: a } = adapters();
      await recordLakeConfigChange(
        {
          actor: actor({ userId: 'alice' }),
          lake: lake({ createdByUserId: 'alice' }),
          action: 'update',
          changes: [change],
        },
        a
      );
      expect(recordedInput(record)).toMatchObject({ principalKind: 'user', principalId: 'alice' });
    });

    // A blank id is "no principal drove this", never "a real principal whose id was lost" - the
    // same call lakeConfigWriteStamp makes when it emits no key at all.
    it('is `system` for a blank actor id rather than a user with an empty id', async () => {
      const { record, adapters: a } = adapters();
      await recordLakeConfigChange(
        { actor: actor({ userId: '' }), lake: lake(), action: 'update', changes: [change] },
        a
      );
      expect(recordedInput(record)).toMatchObject({ principalKind: 'system', principalId: 'system' });
    });

    // Only the route can tell an API key from a session, so a principal it resolved always wins over
    // the userId-derived fallback. Without this, a key-driven reconfiguration is recorded as though
    // the key's owner had made the change by hand - wrong in the one field the row exists to get right.
    describe('resolved by the route (auditPrincipal)', () => {
      it('records the KEY as the principal and keeps the human findable', async () => {
        const { record, adapters: a } = adapters();
        await recordLakeConfigChange(
          {
            actor: actor({
              userId: 'alice',
              auditPrincipal: { principalKind: 'apiKey', principalId: 'key_abc', onBehalfOfUserId: 'alice' },
            }),
            lake: lake(),
            action: 'update',
            changes: [change],
          },
          a
        );
        expect(recordedInput(record)).toMatchObject({
          principalKind: 'apiKey',
          principalId: 'key_abc',
          onBehalfOfUserId: 'alice',
        });
      });

      it('leaves onBehalfOfUserId unset for an ordinary session write - the human IS the principal', async () => {
        const { record, adapters: a } = adapters();
        await recordLakeConfigChange(
          { actor: actor({ userId: 'alice' }), lake: lake(), action: 'update', changes: [change] },
          a
        );
        expect(recordedInput(record)).toMatchObject({ principalKind: 'user', principalId: 'alice' });
        expect(recordedInput(record).onBehalfOfUserId).toBeUndefined();
      });
    });
  });

  describe('manage rung', () => {
    it('resolves from the grants the caller already loaded', async () => {
      const { record, adapters: a } = adapters();
      const grants: LakeGrant[] = [{ principalType: 'user', principalId: 'cur', role: 'curator' }];
      await recordLakeConfigChange(
        { actor: actor({ userId: 'cur' }), lake: lake(), grants, action: 'update', changes: [change] },
        a
      );
      expect(recordedInput(record).manageRung).toBe('grant-curator');
    });

    it('makes a platform admin acting on a lake they do not own visible AS an admin', async () => {
      const { record, adapters: a } = adapters();
      await recordLakeConfigChange(
        { actor: actor({ userId: 'root', isAdmin: true }), lake: lake(), action: 'update', changes: [change] },
        a
      );
      expect(recordedInput(record).manageRung).toBe('platform-admin');
    });

    it('falls back to `system` rather than inventing a rung it cannot resolve', async () => {
      const { record, adapters: a } = adapters();
      // The gate has already passed by the time this runs; an unresolvable rung means the caller
      // authorized on a narrower rule of its own, not that this write was unauthorized.
      await recordLakeConfigChange(
        { actor: actor({ userId: 'stranger' }), lake: lake(), action: 'update', changes: [change] },
        a
      );
      expect(recordedInput(record).manageRung).toBe('system');
    });

    it('honors an explicit override for a write no principal drove', async () => {
      const { record, adapters: a } = adapters();
      await recordLakeConfigChange(
        {
          actor: actor({ userId: 'owner' }),
          lake: lake(),
          action: 'auto-activate',
          changes: [change],
          manageRung: 'system',
        },
        a
      );
      // The actor is still the principal; only the rung is overridden.
      expect(recordedInput(record)).toMatchObject({ manageRung: 'system', principalId: 'owner' });
    });
  });

  describe('retention lever', () => {
    // The settings cache is a module-level global, so without this a case reads the previous
    // case's stored value and passes or fails for the wrong reason.
    beforeEach(() => invalidateSettingsCache());

    /** The cached read path goes through `findAll`, not `findBySettingNames`. */
    const settingsRepo = (rows: { settingName: string; settingValue: string }[]) => ({
      findAll: vi.fn().mockResolvedValue(rows),
      findBySettingNames: vi.fn().mockResolvedValue(rows),
    });

    it('is not read at all when no settings repo is wired - record() still clamps', async () => {
      const { record, adapters: a } = adapters();
      await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a);
      expect(recordedInput(record).retentionDays).toBeUndefined();
    });

    it('is read and passed through when the settings repo IS wired - the lever has a consumer', async () => {
      const adminSettings = settingsRepo([{ settingName: 'LakeConfigAuditRetentionDays', settingValue: '2000' }]);
      const { record, adapters: a } = adapters({ adminSettings });
      await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a);
      expect(adminSettings.findAll).toHaveBeenCalled();
      expect(recordedInput(record).retentionDays).toBe(2000);
    });

    it('clamps a configured value below the floor before it ever leaves the service', async () => {
      const adminSettings = settingsRepo([{ settingName: 'LakeConfigAuditRetentionDays', settingValue: '1' }]);
      const { record, adapters: a } = adapters({ adminSettings });
      await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a);
      expect(recordedInput(record).retentionDays).toBe(LAKE_CONFIG_AUDIT_RETENTION_FLOOR_DAYS);
    });

    it('falls back to the default when the settings read throws, rather than blocking the write', async () => {
      const adminSettings = {
        findAll: vi.fn().mockRejectedValue(new Error('settings down')),
        findBySettingNames: vi.fn().mockRejectedValue(new Error('settings down')),
      };
      const { record, adapters: a } = adapters({ adminSettings });
      await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a);
      expect(record).toHaveBeenCalled();
      expect(recordedInput(record).retentionDays).toBe(LAKE_CONFIG_AUDIT_RETENTION_DEFAULT_DAYS);
    });
  });

  describe('best-effort - the deliberate inverse of the read side', () => {
    // Audit LOSS is an error, not a warning - the read-side twin (recordLakeAccessEvent) logs its
    // own loss at `error`, and an alert keyed off that severity has to catch both halves of the trail
    // or config-audit loss accumulates while only reads page anyone.
    it('swallows a failing event write and logs it at ERROR through the wired logger', async () => {
      const error = vi.fn();
      const { adapters: a } = adapters({
        record: vi.fn().mockRejectedValue(new Error('mongo down')),
        logger: { error },
      });
      await expect(
        recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a)
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('audit event did not persist'),
        expect.objectContaining({ dataLakeId: 'lake1', action: 'update' })
      );
    });

    it('prefers error over warn when the logger offers both', async () => {
      const error = vi.fn();
      const warn = vi.fn();
      const { adapters: a } = adapters({
        record: vi.fn().mockRejectedValue(new Error('mongo down')),
        logger: { warn, error },
      });
      await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a);
      expect(error).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('falls back to warn for a logger that only offers warn, rather than losing the line', async () => {
      const warn = vi.fn();
      const { adapters: a } = adapters({
        record: vi.fn().mockRejectedValue(new Error('mongo down')),
        logger: { warn },
      });
      await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('audit event did not persist'),
        expect.objectContaining({ dataLakeId: 'lake1' })
      );
    });

    it('falls back to console.error when no logger is wired, so it cannot go fully silent', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { adapters: a } = adapters({ record: vi.fn().mockRejectedValue(new Error('mongo down')) });
      await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('audit event did not persist'), expect.anything());
      spy.mockRestore();
    });

    // Called through a closure rather than by reference, so a logger whose method needs `this`
    // still works - the same shape transferLakeOwnership's stamp warning uses.
    it('calls the logger as a method, not a detached function', async () => {
      const logger = {
        seen: [] as string[],
        warn(msg: string) {
          this.seen.push(msg);
        },
      };
      const { adapters: a } = adapters({ record: vi.fn().mockRejectedValue(new Error('boom')), logger });
      await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a);
      expect(logger.seen).toHaveLength(1);
    });
  });
});

describe('recordLakeConfigChange - fake-timer safety', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('computes no expiry itself - the repository owns the clock', async () => {
    const { record, adapters: a } = adapters();
    await recordLakeConfigChange({ actor: actor(), lake: lake(), action: 'update', changes: [change] }, a);
    expect(recordedInput(record)).not.toHaveProperty('expiresAt');
  });
});
