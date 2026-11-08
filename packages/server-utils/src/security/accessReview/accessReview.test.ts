import { describe, expect, it } from 'vitest';
import {
  ACCESS_REVIEW_COUNT_LABELS,
  formatAccessReviewMarkdown,
  formatAccessReviewSlackMessage,
  isAccessReviewReminderDay,
  parseAccessReviewBaseline,
  reviewQuarter,
  type AccessReviewCounts,
  type AccessReviewSnapshot,
} from './accessReview';

const zeroCounts = Object.fromEntries(
  Object.keys(ACCESS_REVIEW_COUNT_LABELS).map(key => [key, 0])
) as AccessReviewCounts;

const snapshot = (overrides: Partial<AccessReviewSnapshot> = {}): AccessReviewSnapshot => ({
  quarter: '2027-Q1',
  generatedAt: '2027-01-04T09:00:00.000Z',
  allApiKeysListed: false,
  counts: { ...zeroCounts, fullAdmins: 2, activeApiKeys: 5 },
  admins: [],
  apiKeys: [],
  supportAccess: [],
  impersonation: [],
  ...overrides,
});

describe('reviewQuarter', () => {
  it.each([
    ['2027-01-01T00:00:00Z', '2027-Q1'],
    ['2027-03-31T23:59:59Z', '2027-Q1'],
    ['2027-04-01T00:00:00Z', '2027-Q2'],
    ['2027-09-30T12:00:00Z', '2027-Q3'],
    ['2027-12-31T12:00:00Z', '2027-Q4'],
    ['2027-03-31T22:00:00-05:00', '2027-Q2'], // already April in UTC
  ])('%s is %s', (date, quarter) => {
    expect(reviewQuarter(new Date(date))).toBe(quarter);
  });
});

describe('isAccessReviewReminderDay', () => {
  it.each([
    ['2027-01-04T09:00:00Z', true], // first Monday of January
    ['2026-10-05T09:00:00Z', true], // first Monday of October
    ['2027-04-05T09:00:00Z', true],
    ['2027-07-05T09:00:00Z', true],
    ['2027-01-11T09:00:00Z', false], // second Monday
    ['2027-01-05T09:00:00Z', false], // a Tuesday in the first week
    ['2027-02-01T09:00:00Z', false], // first Monday of a mid-quarter month
    ['2029-01-01T09:00:00Z', true], // the 1st is a Monday
    ['2030-01-07T09:00:00Z', true], // the 7th is a Monday
    ['2027-01-03T23:30:00-05:00', true], // Sunday locally, Monday in UTC
    ['2027-01-04T20:00:00-08:00', false], // Monday locally, Tuesday in UTC
  ])('%s -> %s', (date, expected) => {
    expect(isAccessReviewReminderDay(new Date(date))).toBe(expected);
  });

  it('fires exactly once per quarter month across a year of daily runs', () => {
    const hits: string[] = [];
    for (let t = Date.UTC(2027, 0, 1, 9); t < Date.UTC(2028, 0, 1); t += 86_400_000) {
      if (isAccessReviewReminderDay(new Date(t))) hits.push(new Date(t).toISOString().slice(0, 10));
    }
    expect(hits).toEqual(['2027-01-04', '2027-04-05', '2027-07-05', '2027-10-04']);
  });
});

describe('parseAccessReviewBaseline', () => {
  it('keeps the quarter, timestamp and counts of a written snapshot', () => {
    const written = JSON.parse(JSON.stringify(snapshot()));
    expect(parseAccessReviewBaseline(written)).toEqual({
      quarter: '2027-Q1',
      generatedAt: '2027-01-04T09:00:00.000Z',
      counts: written.counts,
    });
  });

  it.each([null, {}, { quarter: 'q', generatedAt: 'g', counts: { fullAdmins: -1 } }])('rejects %j', value => {
    expect(() => parseAccessReviewBaseline(value)).toThrow('Baseline is not an access review snapshot');
  });
});

describe('formatAccessReviewMarkdown', () => {
  it('renders every section, with decision columns and None. for empty ones', () => {
    const markdown = formatAccessReviewMarkdown(snapshot());
    expect(markdown).toContain('# Access review 2027-Q1');
    expect(markdown).toContain('| Access | Count |');
    expect(markdown).toContain('| Full admin accounts | 2 |');
    expect(markdown).toContain('| Active API keys | 5 |');
    expect(markdown).toContain('## Admin accounts (0)\n\nNone.');
    expect(markdown).toContain('## Privileged API keys (0)');
    expect(markdown).toContain('The counts above cover every key.');
    expect(markdown).toContain('## Active support access (0)\n\nNone.');
    expect(markdown).toContain('## Active impersonation sessions (0)\n\nNone.');
    expect(markdown).toContain('## Revocations');
    expect(markdown).toContain('docs/security/quarterly-access-review.md');
  });

  it('lists admins, keys and delegations, escaping cells and dashing blanks', () => {
    const markdown = formatAccessReviewMarkdown(
      snapshot({
        allApiKeysListed: true,
        admins: [
          {
            userId: 'u1',
            email: 'one@example.org',
            username: 'one',
            fullAdmin: true,
            permissions: [],
            status: 'active',
            lastActiveAt: '2026-12-30T10:00:00.000Z',
            activeSessions: 2,
            trustedDevices: 1,
            passkeys: 1,
            oauthRefreshTokens: 0,
            bridgeDevices: 0,
            activeApiKeys: 1,
          },
          {
            userId: 'u2',
            email: null,
            username: null,
            fullAdmin: false,
            permissions: ['support:read', 'keys:revoke'],
            status: 'banned',
            lastActiveAt: null,
            activeSessions: 0,
            trustedDevices: 0,
            passkeys: 0,
            oauthRefreshTokens: 0,
            bridgeDevices: 0,
            activeApiKeys: 0,
          },
        ],
        apiKeys: [
          {
            id: 'k1',
            name: 'deploy | bot\nkey',
            ownerId: 'u1',
            ownerEmail: 'one@example.org',
            ownerIsAdmin: true,
            scopes: ['admin:*', 'ai:generate'],
            createdAt: '2026-01-02T00:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
          },
          {
            id: 'k2',
            name: 'reader',
            ownerId: 'u9',
            ownerEmail: null,
            ownerIsAdmin: false,
            scopes: [],
            createdAt: null,
            lastUsedAt: '2026-12-01T00:00:00.000Z',
            expiresAt: '2027-06-01T00:00:00.000Z',
          },
        ],
        supportAccess: [
          {
            sessionId: 'support-session-1',
            adminId: 'u1',
            adminEmail: 'one@example.org',
            userId: 'u7',
            startedAt: '2027-01-03T00:00:00.000Z',
            expiresAt: '2027-01-05T00:00:00.000Z',
          },
        ],
        impersonation: [{ sessionId: 'impersonation-session-1', adminId: 'u3', adminEmail: null, userId: 'u8', startedAt: null, expiresAt: null }],
      })
    );
    expect(markdown).toContain(
      '| one | one@example.org | active | full admin | 2026-12-30 | 2 | 1 | 1 | 0 | 0 | 1 |  |  |'
    );
    expect(markdown).toContain('| u2 | - | banned | support:read, keys:revoke | - | 0 | 0 | 0 | 0 | 0 | 0 |  |  |');
    expect(markdown).toContain('## Active API keys (2)');
    expect(markdown).toContain('Every active, unexpired API key.');
    expect(markdown).toContain(
      '| k1 | deploy \\| bot key | one@example.org | yes | admin:\\*, ai:generate | 2026-01-02 | - | never |  |  |'
    );
    expect(markdown).toContain('| k2 | reader | u9 | no | - | - | 2026-12-01 | 2027-06-01 |  |  |');
    expect(markdown).toContain('| support-session-1 | one@example.org | u7 | 2027-01-03 | 2027-01-05 |  |  |');
    expect(markdown).toContain('| impersonation-session-1 | u3 | u8 | - | - |  |  |');
  });

  it('identifies separate sessions for the same admin and target on the same day', () => {
    const delegations = ['session-1', 'session-2'].map(sessionId => ({
      sessionId,
      adminId: 'admin-1',
      adminEmail: 'admin@example.org',
      userId: 'target-1',
      startedAt: '2027-01-04T09:00:00.000Z',
      expiresAt: '2027-01-04T10:00:00.000Z',
    }));
    const markdown = formatAccessReviewMarkdown(snapshot({ supportAccess: delegations, impersonation: delegations }));
    for (const sessionId of ['session-1', 'session-2']) {
      const row = `| ${sessionId} | admin@example.org | target-1 | 2027-01-04 | 2027-01-04 |  |  |`;
      expect(markdown.split(row)).toHaveLength(3);
    }
  });

  it('adds before, after and change columns against a baseline', () => {
    const markdown = formatAccessReviewMarkdown(
      snapshot({ counts: { ...zeroCounts, fullAdmins: 2, activeApiKeys: 5, passkeys: 3 } }),
      {
        quarter: '2027-Q1',
        generatedAt: '2027-01-04T09:00:00.000Z',
        counts: { fullAdmins: 3, activeApiKeys: 5, passkeys: 1 },
      }
    );
    expect(markdown).toContain('| Access | Before (2027-Q1, 2027-01-04) | After | Change |');
    expect(markdown).toContain('| Full admin accounts | 3 | 2 | -1 |');
    expect(markdown).toContain('| Active API keys | 5 | 5 | 0 |');
    expect(markdown).toContain('| Passkeys | 1 | 3 | +2 |');
    expect(markdown).toContain('| Delegated admin accounts | - | 0 | - |');
  });

  it.each([
    ['normal', 'normal'],
    ['pipe|name', 'pipe\\|name'],
    ['slash\\name', 'slash\\\\name'],
    ['slash\\|pipe', 'slash\\\\\\|pipe'],
    ['double\\\\|pipe', 'double\\\\\\\\\\|pipe'],
    ['line\nbreak\tname', 'line break name'],
    ['[label](https://example.org)', '\\[label\\](https://example.org)'],
    ['<img src="https://example.org">', '&lt;img src="https://example.org"&gt;'],
    ['&lt;name&gt;', '&amp;lt;name&amp;gt;'],
    ['**name** `_key_`', '\\*\\*name\\*\\* \\`\\_key\\_\\`'],
  ])('renders key name %j as literal text in one cell', (name, escapedName) => {
    const markdown = formatAccessReviewMarkdown(
      snapshot({
        apiKeys: [
          {
            id: 'k1',
            name,
            ownerId: 'u1',
            ownerEmail: 'owner@example.org',
            ownerIsAdmin: false,
            scopes: [],
            createdAt: null,
            lastUsedAt: null,
            expiresAt: null,
          },
        ],
      })
    );
    expect(markdown).toContain(`| k1 | ${escapedName} | owner@example.org | no | - | - | - | never |  |  |`);
  });
});

describe('formatAccessReviewSlackMessage', () => {
  it('names the quarter, every count and the runbook, with no per-account detail', () => {
    const message = formatAccessReviewSlackMessage(snapshot());
    expect(message).toContain(':clipboard: *Quarterly access review due: 2027-Q1*');
    expect(message).toContain('- Full admin accounts: 2');
    expect(message).toContain('- Active API keys: 5');
    expect(message.split('\n')).toHaveLength(Object.keys(ACCESS_REVIEW_COUNT_LABELS).length + 3);
    expect(message).toContain('`docs/security/quarterly-access-review.md`');
  });
});
