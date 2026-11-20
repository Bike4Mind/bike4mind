import { describe, expect, it } from 'vitest';
import type { ISpendAlert } from '@bike4mind/common';
import { buildSpendAlertMessage, formatAccountAge, type SpendAlertMessageInput } from './slackMessage';
import type { TopAccountContext } from './topAccountContext';

const appUrl = 'https://app.example.com';
const openedAt = new Date('2026-10-30T10:00:00Z');

const baseAlert: ISpendAlert = {
  rule: 'account_spike',
  scopeType: 'User',
  scopeId: 'u1',
  status: 'open',
  severity: 'critical',
  openedAt,
  peakValue: 7000,
  lastValue: 6000,
  clearRuns: 0,
  context: { baseline: 1500, ratio: 3.8 },
};

const userScope = {
  label: 'jane@example.com',
  payerType: 'User' as const,
  payerId: 'u1',
  adminPath: '/admin/users/u1',
};

const build = (overrides: Partial<SpendAlertMessageInput> = {}) =>
  buildSpendAlertMessage({
    kind: 'open',
    alert: baseAlert,
    scope: userScope,
    creditUsd: 0.01,
    stage: 'production',
    appUrl,
    mention: 'channel',
    ...overrides,
  });

const json = (message: ReturnType<typeof build>) => JSON.stringify(message);

describe('buildSpendAlertMessage', () => {
  const accountContext = {
    accountAgeDays: 30,
    responsibleAccountAgeDays: 60,
    emailVerified: true,
    reviewState: 'approved',
    riskScore: 12,
    reviewReopened: false,
    banned: false,
    paymentRiskEvent: false,
    hasCreditPurchase: true,
    lastCreditPurchaseAgeDays: 5,
    payments: {
      status: 'observed',
      succeeded: 3,
      failed: 1,
      radarBlocked: 0,
      elevatedRisk: 0,
      latestSucceededAgeDays: 2,
    },
    evidence: { status: 'observed', ageHours: 72 },
  };

  it('explains age, risk, retained payments, and the age of behavioral evidence', () => {
    const out = json(
      build({ alert: { ...baseAlert, context: { accountContext, policyReasons: ['established_paid_account'] } } })
    );
    expect(out).toContain('Account age: 30.0 days; responsible owner: 60.0 days');
    expect(out).toContain('Email verified: yes; review: approved; risk score: 12');
    expect(out).toContain('Review reopened: no; payment-risk event: no');
    expect(out).toContain('Unreversed credit purchase: yes');
    expect(out).toContain('3 succeeded, 1 failed, 0 blocked, 0 elevated-risk');
    expect(out).toContain('72.0 hours old');
    expect(out).toContain('established_paid_account');
  });

  it('keeps absent history and evidence unknown and renders risk flags on resolutions', () => {
    const out = json(
      build({
        kind: 'resolve',
        alert: {
          ...baseAlert,
          context: {
            accountContext: {
              ...accountContext,
              accountAgeDays: null,
              responsibleAccountAgeDays: null,
              reviewState: 'unknown',
              riskScore: null,
              paymentRiskEvent: true,
              reviewReopened: true,
              banned: false,
              hasCreditPurchase: null,
              lastCreditPurchaseAgeDays: null,
              payments: {
                status: 'missing',
                succeeded: 0,
                failed: 0,
                radarBlocked: 0,
                elevatedRisk: 0,
                latestSucceededAgeDays: null,
              },
              evidence: { status: 'missing', ageHours: null },
            },
            policyReasons: ['payment_risk_event'],
          },
        },
      })
    );
    expect(out).toContain('Account age: unknown');
    expect(out).toContain('review: unknown; risk score: unknown');
    expect(out).toContain('Review reopened: yes; payment-risk event: yes');
    expect(out).toContain('unknown (no retained payment history)');
    expect(out).toContain('unknown (no behavioral evidence)');
    expect(out).toContain('payment_risk_event');
  });

  it('rejects malformed persisted context and bounds and escapes policy reasons', () => {
    const out = json(
      build({
        alert: {
          ...baseAlert,
          context: {
            accountContext: { accountAgeDays: 'clean' },
            policyReasons: ['<!channel>\nwrong', ...Array.from({ length: 10 }, () => 'x'.repeat(1000))],
          },
        },
      })
    );
    expect(out).toContain('unknown (unavailable or invalid)');
    expect(out).toContain('&lt;!channel&gt; wrong');
    expect(out).not.toContain('x'.repeat(101));
    expect(out).not.toContain('Account age: clean');
  });

  it('renders a critical account alert with figures, mention and user button', () => {
    const out = json(build());
    expect(out).toContain('Spend critical: Account spend spike');
    expect(out).toContain('jane@example.com');
    expect(out).toContain('6,000 credits (~$60.00)');
    expect(out).toContain('x3.8');
    expect(out).toContain('Last 15m');
    expect(out).toContain('Normal (15m)');
    expect(out).toContain('in the last 15m');
    expect(out).toContain('<!channel>');
    expect(out).toContain(`${appUrl}/admin/users/u1`);
    expect(out).toContain(`${appUrl}/admin?tab=credit-analytics`);
  });

  it('does not mention for a warning', () => {
    const out = json(build({ alert: { ...baseAlert, severity: 'warning' } }));
    expect(out).not.toContain('<!channel>');
    expect(out).toContain('Spend warning');
  });

  it('omits the user button for an org scope without an admin path', () => {
    const out = json(build({ scope: { label: 'Acme', payerType: 'Organization', payerId: 'o1', adminPath: null } }));
    expect(out).not.toContain('/admin/users/');
    expect(out).toContain('Credit analytics');
    expect(out).not.toContain('Paid by');
  });

  it('names the paying organization when it differs from the scope label', () => {
    const out = json(
      build({ scope: { ...userScope, label: 'org-key (jane@example.com)', payerType: 'Organization', paidBy: 'Acme' } })
    );
    expect(out).toContain('Paid by');
    expect(out).toContain('Acme');
  });

  it('renders no history and n/a when baseline and ratio are missing', () => {
    const out = json(build({ alert: { ...baseAlert, context: { baseline: null, ratio: null } } }));
    expect(out).toContain('no history');
    expect(out).toContain('n/a');
  });

  it('renders platform cost spikes in USD without credit conversion', () => {
    const out = json(
      build({
        alert: {
          ...baseAlert,
          rule: 'platform_cost_spike',
          scopeType: 'platform',
          scopeId: 'all',
          lastValue: 42.5,
          context: { baseline: 10, ratio: 4.25 },
        },
      })
    );
    expect(out).toContain('Platform provider-cost spike');
    expect(out).toContain('$42.50');
    expect(out).toContain('$10.00');
    expect(out).not.toContain('credits (~');
  });

  it('shows top accounts for platform rules only, and the source mix for both', () => {
    const breakdown = {
      topModels: [{ model: 'gpt-x', credits: 1200 }],
      topAccounts: [{ label: 'big@example.com', credits: 3000 }],
      sources: { cli: 1000, desktop: 5000 },
    };
    const platform = json(
      build({ alert: { ...baseAlert, rule: 'platform_spike', scopeType: 'platform', scopeId: 'all' }, breakdown })
    );
    expect(platform).toContain('big@example.com: 3,000');
    expect(platform).toContain('Where it was spent (credits)');
    const account = json(build({ breakdown }));
    // Largest source first.
    expect(account).toContain('desktop: 5,000\\ncli: 1,000');
    expect(account).toContain('gpt-x: 1,200');
    expect(account).not.toContain('Top accounts');
  });

  it('shows the trusted share left out of a platform ratio', () => {
    const platformAlert = {
      ...baseAlert,
      rule: 'platform_spike' as const,
      scopeType: 'platform' as const,
      scopeId: 'all',
      context: { baseline: 300, ratio: 30, trustedExcluded: 6000 },
    };
    const out = json(build({ alert: platformAlert }));
    expect(out).toContain('Normal excl. trusted (15m)');
    expect(out).toContain('Trusted accounts, not in ratio*\\n6,000 credits');
    const plain = json(build({ alert: { ...platformAlert, context: { baseline: 300, ratio: 30 } } }));
    expect(plain).toContain('Normal (15m)');
    expect(plain).not.toContain('not in ratio');
  });

  it('marks a cost estimate for the trusted share of a cost spike', () => {
    const costAlert = {
      ...baseAlert,
      rule: 'platform_cost_spike' as const,
      scopeType: 'platform' as const,
      scopeId: 'all',
      context: { baseline: 10, ratio: 6, trustedExcluded: 12.5 },
    };
    expect(json(build({ alert: costAlert }))).toContain('$12.50 (est.)');
  });

  it('marks a trusted account on the scope line, the context and the resolve', () => {
    const trustedAlert = { ...baseAlert, context: { ...baseAlert.context, trusted: true } };
    const out = json(build({ alert: trustedAlert }));
    expect(out).toContain('jane@example.com (trusted)');
    expect(out).toContain('trusted-account limits');
    const resolved = json(build({ kind: 'resolve', alert: { ...trustedAlert, resolvedAt: openedAt } }));
    expect(resolved).toContain('jane@example.com (trusted), peak');
    expect(json(build())).not.toContain('trusted');
  });

  it('shows the paid tier and applied limits on open and resolved alerts', () => {
    const paidAlert = {
      ...baseAlert,
      context: {
        baseline: null,
        ratio: null,
        accountTier: 'paid',
        spikeFloorCredits: 20000,
        ceilingCredits: 40000,
      },
    };
    for (const kind of ['open', 'resolve'] as const) {
      const out = json(build({ kind, alert: paidAlert }));
      expect(out).toContain('jane@example.com (paid)');
      expect(out).toContain('paid-account limits');
      expect(out).toContain('spike floor: 20,000 credits / 15m');
      expect(out).toContain('critical ceiling: 40,000 credits / 15m');
      expect(out).not.toContain('trusted');
    }
    const out = json(build({ alert: paidAlert }));
    expect(out).toContain('no history');
    expect(out).toContain('n/a');
  });

  it('renders a short resolve message with peak and duration', () => {
    const out = json(build({ kind: 'resolve', alert: { ...baseAlert, resolvedAt: new Date('2026-10-30T12:10:00Z') } }));
    expect(out).toContain('Resolved: Account spend spike - jane@example.com, peak 7,000 credits, lasted 2h 10m');
    expect(out).not.toContain('<!channel>');
  });

  it('formats sub-hour durations in minutes', () => {
    const out = json(build({ kind: 'resolve', alert: { ...baseAlert, resolvedAt: new Date('2026-10-30T10:45:00Z') } }));
    expect(out).toContain('lasted 45m');
  });

  it('emits ASCII only for ASCII inputs', () => {
    const open = json(build());
    const resolved = json(build({ kind: 'resolve' }));
    expect(open).toMatch(/^\p{ASCII}*$/u);
    expect(resolved).toMatch(/^\p{ASCII}*$/u);
  });

  it('passes non-ASCII names through unchanged', () => {
    const label = `J${String.fromCharCode(0xe9)}r${String.fromCharCode(0xf4)}me`;
    expect(json(build({ scope: { ...userScope, label } }))).toContain(label);
    expect(json(build({ kind: 'resolve', scope: { ...userScope, label } }))).toContain(label);
  });

  it('marks escalations in the context line', () => {
    expect(json(build({ kind: 'escalate' }))).toContain('escalated, critical');
  });

  it('omits the list-price note on a resolved cost spike', () => {
    const alert = {
      ...baseAlert,
      rule: 'platform_cost_spike' as const,
      peakValue: 55,
      resolvedAt: new Date('2026-10-30T10:30:00Z'),
    };
    const out = json(build({ kind: 'resolve', alert }));
    expect(out).toContain('peak $55.00');
    expect(out).not.toContain('list price');
  });

  it('prints the list price per 1,000 credits on open and resolve cards', () => {
    const resolved = { ...baseAlert, resolvedAt: new Date('2026-10-30T10:30:00Z') };

    expect(json(build({ creditUsd: 0.0012 }))).toContain('approx. at list price, $1.20 per 1,000 credits');
    expect(json(build({ kind: 'resolve', alert: resolved, creditUsd: 0.0012 }))).toContain(
      'approx. at list price, $1.20 per 1,000 credits'
    );
  });

  it('lists the folded API keys in an escaped Via API keys field', () => {
    const alert = { ...baseAlert, context: { ...baseAlert.context, viaKeys: ['ci-key', 'a&b'] } };
    const out = json(build({ alert }));

    expect(out).toContain('*Via API keys*');
    expect(out).toContain('ci-key, a&amp;b');
    expect(json(build())).not.toContain('Via API keys');
  });

  it('keeps a key name on one line and bounds its length', () => {
    const long = 'x'.repeat(80);
    const alert = { ...baseAlert, context: { ...baseAlert.context, viaKeys: ['first\nsecond', long] } };
    const out = json(build({ alert }));

    expect(out).toContain('first second');
    expect(out).toContain(`${'x'.repeat(60)}...`);
    expect(out).not.toContain(long);
  });

  it.each(['x', '&'])('bounds the complete folded-key field after escaping %s names', character => {
    const alert = {
      ...baseAlert,
      context: { ...baseAlert.context, viaKeys: Array.from({ length: 100 }, () => character.repeat(80)) },
    };
    const message = build({ alert });
    const fields = message.attachments
      ?.flatMap(attachment => attachment.blocks)
      .flatMap(block => {
        if (typeof block !== 'object' || block === null || !('fields' in block) || !Array.isArray(block.fields))
          return [];
        return block.fields.flatMap((field: unknown) => {
          if (typeof field !== 'object' || field === null || !('text' in field) || typeof field.text !== 'string')
            return [];
          return [field.text];
        });
      });
    const keyField = fields?.find(field => field.startsWith('*Via API keys*'));
    expect(keyField).toBeDefined();
    expect(keyField?.length).toBeLessThanOrEqual(2000);
    expect(keyField).toMatch(/, \+\d+ more$/);
    expect(keyField).not.toMatch(/&(?:a|am|amp)?(?:,|$)/);
  });
});

describe('top accounts on platform alarms', () => {
  const MINUTE_MS = 60_000;
  const DAY_MS = 24 * 60 * MINUTE_MS;
  const NEW_USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const ORG_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const PAID_USER_ID = 'cccccccccccccccccccccccc';
  const platformAlert: ISpendAlert = { ...baseAlert, rule: 'platform_spike', scopeType: 'platform', scopeId: 'all' };
  const platformScope = { label: 'Platform', payerType: 'unknown' as const, payerId: null, adminPath: null };

  const newFreeUser: TopAccountContext = {
    kind: 'user',
    adminPath: `/admin/users/${NEW_USER_ID}`,
    ageMs: 13 * MINUTE_MS,
    creditBalance: 1000,
    funding: 'granted',
    topModel: { model: 'opus-x', calls: 3 },
  };
  const preFundedOrg: TopAccountContext = {
    kind: 'org',
    adminPath: `/admin?tab=organizations&orgId=${ORG_ID}`,
    ageMs: 400 * DAY_MS,
    creditBalance: 2_500_000,
    funding: 'purchase',
    topModel: { model: 'flux-3-video', calls: 42 },
  };
  const paidUser: TopAccountContext = {
    kind: 'user',
    adminPath: `/admin/users/${PAID_USER_ID}`,
    ageMs: 3 * 365 * DAY_MS + DAY_MS,
    creditBalance: 50_000,
    funding: 'subscription',
    topModel: null,
  };

  const buildPlatform = (topAccounts: NonNullable<SpendAlertMessageInput['breakdown']>['topAccounts'], url = appUrl) =>
    build({
      alert: platformAlert,
      scope: platformScope,
      appUrl: url,
      breakdown: { topModels: [{ model: 'flux-3-video', credits: 3700 }], topAccounts },
    });

  /** The Top accounts section as Slack renders it, or null when the card has none. */
  const topAccountsText = (message: ReturnType<typeof build>): string | null => {
    const match = /"(\*Top accounts \(credits\)\*(?:[^"\\]|\\.)*)"/.exec(JSON.stringify(message));
    return match ? (JSON.parse(`"${match[1]}"`) as string) : null;
  };

  it('flags a minutes-old free account with its model and admin link', () => {
    const text = topAccountsText(
      buildPlatform([{ label: 'new-signup@example.com', credits: 2400, account: newFreeUser }])
    );
    expect(text).toBe(
      [
        '*Top accounts (credits)*',
        `new-signup@example.com: 2,400 - user, 13 min old, balance 1,000, free (granted credits only); opus-x x3 <${appUrl}/admin/users/${NEW_USER_ID}|admin>`,
      ].join('\n')
    );
  });

  it('shows an old pre-funded org as paid, with its org admin link', () => {
    const text = topAccountsText(buildPlatform([{ label: 'Example Labs', credits: 3812, account: preFundedOrg }]));
    expect(text).toBe(
      [
        '*Top accounts (credits)*',
        `Example Labs: 3,812 - org, 1 y old, balance 2,500,000, paid (credit purchase); flux-3-video x42 <${appUrl}/admin?tab=organizations&orgId=${ORG_ID}|admin>`,
      ].join('\n')
    );
  });

  it('shows an old subscriber with no model activity and keeps every account on its own line', () => {
    const text = topAccountsText(
      buildPlatform([
        { label: 'Example Labs', credits: 3812, account: preFundedOrg },
        { label: 'subscriber@example.com', credits: 900, account: paidUser },
      ])
    );
    const lines = text?.split('\n') ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      `subscriber@example.com: 900 - user, 3 y old, balance 50,000, paid (subscription) <${appUrl}/admin/users/${PAID_USER_ID}|admin>`
    );
  });

  it("falls back to today's label and credits when the lookup failed", () => {
    const failed = buildPlatform([
      { label: 'new-signup@example.com', credits: 2400 },
      { label: 'Example Labs', credits: 3812 },
    ]);
    expect(topAccountsText(failed)).toBe(
      ['*Top accounts (credits)*', 'new-signup@example.com: 2,400', 'Example Labs: 3,812'].join('\n')
    );
    expect(json(failed)).not.toContain('|admin>');
  });

  it('escapes the model name and leaves the link out without an app URL', () => {
    const text = topAccountsText(
      buildPlatform(
        [
          {
            label: 'new-signup@example.com',
            credits: 10,
            account: { ...newFreeUser, creditBalance: null, ageMs: null, topModel: { model: '<!here>', calls: 1 } },
          },
        ],
        ''
      )
    );
    expect(text).toContain('user, age unknown, balance unknown, free (granted credits only); &lt;!here&gt; x1');
    expect(text).not.toContain('|admin>');
  });

  it('formats account age coarsely', () => {
    expect(formatAccountAge(0)).toBe('1 min old');
    expect(formatAccountAge(59 * MINUTE_MS)).toBe('59 min old');
    expect(formatAccountAge(60 * MINUTE_MS)).toBe('1 h old');
    expect(formatAccountAge(2 * DAY_MS - 1)).toBe('47 h old');
    expect(formatAccountAge(2 * DAY_MS)).toBe('2 d old');
    expect(formatAccountAge(365 * DAY_MS)).toBe('1 y old');
    expect(formatAccountAge(null)).toBe('age unknown');
  });
});
