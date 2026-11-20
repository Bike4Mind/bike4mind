import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const { recordAdminAction, adminAuditLog } = vi.hoisted(() => ({ recordAdminAction: vi.fn(), adminAuditLog: {} }));
vi.mock('@bike4mind/services', () => ({ adminAuditService: { recordAdminAction } }));
vi.mock('@bike4mind/database', () => ({ adminAuditLogRepository: adminAuditLog }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  loadCreditGrantPolicy: vi.fn(),
  toUserActor: (user: { id: string; name: string; isAdmin: boolean }, scope: string) => ({
    kind: 'user',
    scope,
    userId: user.id,
    name: user.name,
    wasAdmin: user.isAdmin,
  }),
}));

import { adminAssistantAuditWriter } from './auditWriter';

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const context = { user: { id: 'admin-1', name: 'Ada', isAdmin: true }, logger } as unknown as Pick<
  ToolContext,
  'user' | 'logger'
>;

const input = {
  action: 'feedback.viewed' as const,
  target: { kind: 'user' as const, id: 'user-2', displayName: 'user-2' },
  summary: 'viewed 1 feedback report(s) from 1 user(s)',
};

beforeEach(() => {
  recordAdminAction.mockReset().mockResolvedValue(null);
});

describe('adminAssistantAuditWriter', () => {
  it('attributes the entry to the chat user and names the tool as the route', async () => {
    await adminAssistantAuditWriter(context, 'admin_get_user_feedback')(input);

    expect(recordAdminAction).toHaveBeenCalledWith(
      {
        ...input,
        actor: { kind: 'user', scope: 'platform', userId: 'admin-1', name: 'Ada', wasAdmin: true },
        context: { source: 'admin_ui', route: 'admin-assistant/admin_get_user_feedback' },
      },
      { db: { adminAuditLog }, creditGrantPolicy: undefined, logger }
    );
  });

  it('propagates a failed write so the tool call fails', async () => {
    recordAdminAction.mockRejectedValue(new Error('audit store down'));

    await expect(adminAssistantAuditWriter(context, 'admin_get_user_feedback')(input)).rejects.toThrow(
      'audit store down'
    );
  });
});
