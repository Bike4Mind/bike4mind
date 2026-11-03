// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeContributedStringSetting, registerContributedSettings, resetContributedSettings } from '@bike4mind/common';
import { adminAuditService } from '@bike4mind/services';

const recordAdminActionFromRequest = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest }));

import { diffSettingChanges, recordAdminSettingChange } from './adminSettingsAudit';

const req = { user: { id: 'admin-1' } } as unknown as Parameters<typeof recordAdminSettingChange>[0];

beforeEach(() => {
  vi.clearAllMocks();
  recordAdminActionFromRequest.mockResolvedValue(null);
});

describe('diffSettingChanges', () => {
  it('returns one change per differing top-level key of plain objects', () => {
    const changes = diffSettingChanges('cfg', { a: 1, b: 2, c: 3 }, { a: 1, b: 9, c: 3 });
    expect(changes).toEqual([{ field: 'cfg.b', before: 2, after: 9 }]);
  });

  it('reports added and removed keys', () => {
    const changes = diffSettingChanges('cfg', { a: 1 }, { b: 2 });
    expect(changes).toEqual([
      { field: 'cfg.a', before: 1, after: undefined },
      { field: 'cfg.b', before: undefined, after: 2 },
    ]);
  });

  it('compares nested values structurally', () => {
    const changes = diffSettingChanges('cfg', { n: { x: 1 } }, { n: { x: 1 } });
    expect(changes).toEqual([{ field: 'cfg', before: { n: { x: 1 } }, after: { n: { x: 1 } } }]);
  });

  it('falls back to a single whole-value change for non-objects', () => {
    expect(diffSettingChanges('cfg', 'a', 'b')).toEqual([{ field: 'cfg', before: 'a', after: 'b' }]);
    expect(diffSettingChanges('cfg', null, { a: 1 })).toEqual([{ field: 'cfg', before: null, after: { a: 1 } }]);
    expect(diffSettingChanges('cfg', [1], [2])).toEqual([{ field: 'cfg', before: [1], after: [2] }]);
  });
});

describe('recordAdminSettingChange', () => {
  it('writes the strict settings.admin_settings.updated entry with the setting as target', async () => {
    await recordAdminSettingChange(req, { settingName: 'operationsModel', before: { a: 1 }, after: { a: 2 } });

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(req, {
      action: 'settings.admin_settings.updated',
      target: { kind: 'settings', id: 'operationsModel', displayName: 'operationsModel' },
      summary: 'updated operationsModel',
      changes: [{ field: 'operationsModel.a', before: 1, after: 2 }],
      details: undefined,
    });
  });

  it('records a cleared summary when after is null', async () => {
    await recordAdminSettingChange(req, { settingName: 'operationsModel', before: { a: 1 }, after: null });

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        summary: 'cleared operationsModel',
        changes: [{ field: 'operationsModel', before: { a: 1 }, after: null }],
      })
    );
  });

  it('honours the summary, target and details overrides', async () => {
    await recordAdminSettingChange(req, {
      settingName: 'operationsModel',
      before: 1,
      after: 2,
      summary: 'custom summary',
      target: { id: 'x@org:1', displayName: 'X (org 1)' },
      details: { scopeLevel: 'org' },
    });

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        summary: 'custom summary',
        target: { kind: 'settings', id: 'x@org:1', displayName: 'X (org 1)' },
        details: { scopeLevel: 'org' },
      })
    );
  });

  it('redacts both sides of a sensitive setting', async () => {
    await recordAdminSettingChange(req, { settingName: 'openaiDemoKey', before: 'sk-old', after: 'sk-new' });

    const [, entry] = recordAdminActionFromRequest.mock.calls[0];
    expect(entry.changes).toEqual([
      {
        field: 'openaiDemoKey',
        before: adminAuditService.REDACTED_PLACEHOLDER,
        after: adminAuditService.REDACTED_PLACEHOLDER,
      },
    ]);
    expect(JSON.stringify(entry)).not.toContain('sk-');
  });

  describe('contributed settings', () => {
    afterEach(() => resetContributedSettings());

    it('redacts a registered sensitive contributed setting', async () => {
      registerContributedSettings([
        makeContributedStringSetting({
          key: 'extensionToken',
          name: 'Extension token',
          description: 'A contributed secret',
          defaultValue: undefined,
          isSensitive: true,
        }),
      ]);

      await recordAdminSettingChange(req, { settingName: 'extensionToken', before: 'tok-old', after: 'tok-new' });

      const [, entry] = recordAdminActionFromRequest.mock.calls[0];
      expect(entry.changes).toEqual([
        {
          field: 'extensionToken',
          before: adminAuditService.REDACTED_PLACEHOLDER,
          after: adminAuditService.REDACTED_PLACEHOLDER,
        },
      ]);
      expect(JSON.stringify(entry)).not.toContain('tok-');
    });
  });

  it('propagates a failing audit write', async () => {
    recordAdminActionFromRequest.mockRejectedValue(new Error('audit down'));
    await expect(
      recordAdminSettingChange(req, { settingName: 'operationsModel', before: 1, after: 2 })
    ).rejects.toThrow('audit down');
  });
});
