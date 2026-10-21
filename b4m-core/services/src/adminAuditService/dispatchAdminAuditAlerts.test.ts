import { describe, expect, it, vi } from 'vitest';
import type { AdminAuditAlertState, AuditEntry, AuditLogCursor } from '@bike4mind/common';
import {
  ALERT_SETTLE_MS,
  BURST_GRANT_LIMIT,
  BURST_WINDOW_MS,
  dispatchAdminAuditAlerts,
  formatCriticalAlert,
  type AdminAuditAlertAdapters,
} from './dispatchAdminAuditAlerts';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let nextId = 1;
const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: (nextId++).toString(16).padStart(24, '0'),
  source: 'admin',
  occurredAt: minutesAgo(5),
  action: 'user.role.admin_granted',
  category: 'access',
  severity: 'critical',
  actor: { kind: 'user', scope: 'platform', userId: 'admin1', name: 'Ada', email: 'ada@example.com', wasAdmin: true },
  target: { kind: 'user', id: 'user1', displayName: 'Bob' },
  summary: 'granted the admin role',
  reason: 'on-call <rotation>',
  context: { source: 'admin_ui' },
  ...overrides,
});

const grant = (occurredAt: Date, credits = 100): AuditEntry =>
  entry({
    action: 'user.credits.adjusted',
    category: 'credits',
    severity: 'notice',
    occurredAt,
    summary: `granted ${credits} credits`,
    details: { credits },
  });

const setup = ({
  state = { cursor: { occurredAt: minutesAgo(30), id: '0'.repeat(24) }, openBursts: [] },
  entries = [],
  grantCounts = () => 0,
  postResults = [],
  webhookUrl = 'https://hooks.example.com/x',
}: {
  state?: AdminAuditAlertState | null;
  entries?: AuditEntry[];
  grantCounts?: (to: Date) => number;
  postResults?: boolean[];
  webhookUrl?: string;
} = {}) => {
  const save = vi.fn(async (_state: Omit<AdminAuditAlertState, 'updatedAt'>) => undefined);
  const listAscending = vi.fn(async (_page: { after: AuditLogCursor | null; until: Date; limit: number }) => entries);
  const postMessage = vi.fn(async (_url: string, _text: string) => postResults.shift() ?? true);
  const adapters: AdminAuditAlertAdapters = {
    db: {
      adminAuditLog: {
        listAscending,
        countCreditGrants: vi.fn(async (_actor: string, window: { from: Date; to: Date }) => grantCounts(window.to)),
      },
      alertState: { get: vi.fn(async () => state), save },
    },
    webhookUrl,
    postMessage,
    toAppUrl: path => `https://app.example.com${path}`,
    logger: { info: vi.fn(), error: vi.fn() },
    now: () => NOW,
  };
  return { adapters, save, listAscending, postMessage };
};

describe('dispatchAdminAuditAlerts', () => {
  it('starts the cursor at now on the first run instead of replaying history', async () => {
    const { adapters, save, postMessage } = setup({ state: null });
    await expect(dispatchAdminAuditAlerts(adapters)).resolves.toEqual({ status: 'initialized' });
    expect(save).toHaveBeenCalledWith({
      cursor: { occurredAt: new Date(NOW.getTime() - ALERT_SETTLE_MS), id: '0'.repeat(24) },
      openBursts: [],
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts nothing and keeps the cursor at now while the webhook is unset', async () => {
    const { adapters, save, listAscending, postMessage } = setup({ webhookUrl: '' });
    await expect(dispatchAdminAuditAlerts(adapters)).resolves.toEqual({ status: 'disabled' });
    expect(listAscending).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(save.mock.calls[0][0].cursor.occurredAt).toEqual(new Date(NOW.getTime() - ALERT_SETTLE_MS));
  });

  it('reads past the cursor only up to the settle window', async () => {
    const { adapters, listAscending } = setup();
    await dispatchAdminAuditAlerts(adapters);
    expect(listAscending.mock.calls[0][0]).toMatchObject({ until: new Date(NOW.getTime() - ALERT_SETTLE_MS) });
  });

  it('posts each critical entry, skips the rest, and advances the cursor past all of them', async () => {
    const critical = entry();
    const routine = entry({ action: 'user.email.verified', category: 'identity', severity: 'info' });
    const { adapters, save, postMessage } = setup({ entries: [critical, routine] });

    await expect(dispatchAdminAuditAlerts(adapters)).resolves.toEqual({
      status: 'ran',
      scanned: 2,
      alerted: 1,
      blocked: false,
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toContain(`entryId=${critical.id}`);
    expect(save).toHaveBeenCalledWith({ cursor: { occurredAt: routine.occurredAt, id: routine.id }, openBursts: [] });
  });

  it('stops at a failed post so the entry is retried on the next run', async () => {
    const first = entry();
    const failing = entry();
    const after = entry();
    const { adapters, save, postMessage } = setup({ entries: [first, failing, after], postResults: [true, false] });

    await expect(dispatchAdminAuditAlerts(adapters)).resolves.toMatchObject({ alerted: 1, blocked: true });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0].cursor).toEqual({ occurredAt: first.occurredAt, id: first.id });
  });

  it('does not save when nothing moved', async () => {
    const { adapters, save } = setup({ entries: [entry()], postResults: [false] });
    await dispatchAdminAuditAlerts(adapters);
    expect(save).not.toHaveBeenCalled();
  });

  it('alerts once per burst, not once per grant', async () => {
    const grants = [grant(minutesAgo(9)), grant(minutesAgo(8)), grant(minutesAgo(7))];
    const { adapters, save, postMessage } = setup({ entries: grants, grantCounts: () => BURST_GRANT_LIMIT + 1 });

    await dispatchAdminAuditAlerts(adapters);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toContain('Credit grant burst');
    expect(postMessage.mock.calls[0][1]).toContain('actorUserId=admin1');
    expect(save.mock.calls[0][0].openBursts).toEqual([{ actorUserId: 'admin1', lastGrantAt: grants[2].occurredAt }]);
  });

  it('keeps a burst open across runs and opens a new one after a quiet window', async () => {
    const open = { actorUserId: 'admin1', lastGrantAt: minutesAgo(5) };
    const cursor = { occurredAt: minutesAgo(5), id: '0'.repeat(24) };
    const continuing = setup({
      state: { cursor, openBursts: [open] },
      entries: [grant(minutesAgo(4))],
      grantCounts: () => BURST_GRANT_LIMIT + 5,
    });
    await dispatchAdminAuditAlerts(continuing.adapters);
    expect(continuing.postMessage).not.toHaveBeenCalled();

    const later = new Date(open.lastGrantAt.getTime() + BURST_WINDOW_MS + 60_000);
    const renewed = setup({
      state: { cursor, openBursts: [open] },
      entries: [grant(later)],
      grantCounts: () => BURST_GRANT_LIMIT + 1,
    });
    await dispatchAdminAuditAlerts(renewed.adapters);
    expect(renewed.postMessage).toHaveBeenCalledTimes(1);
  });

  it('does not count a deduction or a grant at the limit as a burst', async () => {
    const deduction = grant(minutesAgo(3), -500);
    const { adapters, postMessage } = setup({
      entries: [deduction, grant(minutesAgo(2))],
      grantCounts: () => BURST_GRANT_LIMIT,
    });
    await dispatchAdminAuditAlerts(adapters);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('sends a critical grant that also opens a burst as one message', async () => {
    const big = { ...grant(minutesAgo(3), 90_000), severity: 'critical' as const };
    const { adapters, postMessage } = setup({ entries: [big], grantCounts: () => BURST_GRANT_LIMIT + 1 });
    await dispatchAdminAuditAlerts(adapters);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toMatch(/Critical admin action[\s\S]*Credit grant burst/);
  });

  it('prunes bursts that have gone quiet', async () => {
    const stale = { actorUserId: 'admin2', lastGrantAt: minutesAgo(60) };
    const { adapters, save } = setup({
      state: { cursor: { occurredAt: minutesAgo(30), id: '0'.repeat(24) }, openBursts: [stale] },
    });
    await dispatchAdminAuditAlerts(adapters);
    expect(save.mock.calls[0][0].openBursts).toEqual([]);
  });
});

describe('formatCriticalAlert', () => {
  it('names actor, target and reason, escapes Slack control characters, and links the entry', () => {
    const text = formatCriticalAlert(entry({ id: 'abc' }), 'https://app.example.com/admin?entryId=abc');
    expect(text).toContain('Ada (ada@example.com) granted the admin role');
    expect(text).toContain('*Target:* user Bob (user1)');
    expect(text).toContain('*Reason:* on-call &lt;rotation&gt;');
    expect(text).toContain('<https://app.example.com/admin?entryId=abc|Open in the Audit Log>');
  });

  it('explains which grant threshold escalated the entry', () => {
    const text = formatCriticalAlert(
      entry({ details: { credits: 250, grantThresholdExceeded: { kind: 'dailyTotal', limitCredits: 200_000 } } }),
      null
    );
    expect(text).toContain('past 200,000 credits granted in 24 hours');
    expect(text).not.toContain('Open in the Audit Log');
  });

  it('says when no reason was given and marks an API-key actor', () => {
    const text = formatCriticalAlert(
      entry({ reason: undefined, actor: { kind: 'apiKey', scope: 'platform', name: 'Ada', wasAdmin: true } }),
      null
    );
    expect(text).toContain('Ada via API key');
    expect(text).toContain('_none given_');
  });
});
