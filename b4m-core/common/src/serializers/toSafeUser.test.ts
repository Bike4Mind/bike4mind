import { describe, it, expect } from 'vitest';
import type { IUser } from '../types/entities/UserTypes';
import {
  toSafeUser,
  toSafeUsers,
  redactUserSecretsForSelf,
  USER_SECRET_FIELDS,
  USER_SUBFIELD_REDACTED_FIELDS,
} from './toSafeUser';

// A user carrying every category of secret. Not every required nested field is
// populated, so cast once here rather than fighting the type in a fixture.
const fullUser = {
  id: 'u1',
  name: 'Jane Doe',
  username: 'jane',
  email: 'jane@example.com',
  photoUrl: 'https://cdn/x.png',
  phone: '+15551234567',
  isOnline: true,
  lastActiveAt: new Date('2026-01-01'),
  password: 'BCRYPT-HASH',
  mfa: { totpEnabled: true, totpSecret: 'TOTP-SECRET', backupCodes: ['BK1', 'BK2'], setupAt: new Date() },
  oauthCredentials: { strategy: 'google', accessToken: 'OAUTH-ACCESS', refreshToken: 'OAUTH-REFRESH' },
  authProviders: [{ id: 'p', strategy: 'saml', accessToken: 'AP-ACCESS', refreshToken: 'AP-REFRESH' }],
  googleDrive: { accessToken: 'GD-ACCESS', refreshToken: 'GD-REFRESH', expiresAt: new Date() },
  atlassianConnect: {
    accessToken: 'ATL-ACCESS',
    refreshToken: 'ATL-REFRESH',
    expiresAt: new Date(),
    siteName: 'acme',
    resources: [],
    connectedAt: new Date(),
    status: 'connected',
  },
  notionConnect: {
    accessToken: 'NOTION-ACCESS',
    workspaceId: 'w',
    workspaceName: 'WS',
    botId: 'b',
    connectedAt: new Date(),
  },
  slackSettings: { slackUserId: 'U1', slackUserToken: 'SLACK-TOKEN', defaultNotebookId: 'n1' },
  blogIntegration: { apiKey: 'BLOG-KEY', baseUrl: 'https://blog', defaultAuthor: 'Jane' },
  resetPasswordToken: 'RESET-TOKEN',
  emailVerificationToken: 'EMAILVERIFY-TOKEN',
  pendingEmailToken: 'PENDING-TOKEN',
  pendingEmail: 'new@example.com',
  securityQuestions: [{ question: 'q', answer: 'ANSWER-SECRET' }],
  stripeCustomerId: 'cus_SECRET',
  loginRecords: [{ ip: 'LOGINREC-SECRET', userAgent: 'ua', loginTime: new Date() }],
  userNotes: [{ timestamp: 't', note: 'USERNOTE-SECRET', userName: 'admin' }],
} as unknown as IUser;

// Every secret VALUE that must never appear in any serialized output.
const SECRET_VALUES = [
  'BCRYPT-HASH',
  'TOTP-SECRET',
  'BK1',
  'BK2',
  'OAUTH-ACCESS',
  'OAUTH-REFRESH',
  'AP-ACCESS',
  'AP-REFRESH',
  'GD-ACCESS',
  'GD-REFRESH',
  'ATL-ACCESS',
  'ATL-REFRESH',
  'NOTION-ACCESS',
  'SLACK-TOKEN',
  'BLOG-KEY',
  'RESET-TOKEN',
  'EMAILVERIFY-TOKEN',
  'PENDING-TOKEN',
  'ANSWER-SECRET',
  'cus_SECRET',
  'LOGINREC-SECRET',
  'USERNOTE-SECRET',
];

const expectNoSecretValues = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const secret of SECRET_VALUES) {
    expect(json).not.toContain(secret);
  }
};

describe('toSafeUser', () => {
  it('public scope returns only the public fields, no email, no secrets', () => {
    const safe = toSafeUser(fullUser, 'public');
    expect(safe).toEqual({
      id: 'u1',
      name: 'Jane Doe',
      username: 'jane',
      photoUrl: 'https://cdn/x.png',
      isOnline: true,
      lastActiveAt: fullUser.lastActiveAt,
    });
    expect('email' in safe!).toBe(false);
    expectNoSecretValues(safe);
  });

  it('same-org and self scopes add email but nothing else', () => {
    for (const scope of ['same-org', 'self'] as const) {
      const safe = toSafeUser(fullUser, scope);
      expect(safe!.email).toBe('jane@example.com');
      expect(Object.keys(safe!).sort()).toEqual(
        ['email', 'id', 'isOnline', 'lastActiveAt', 'name', 'photoUrl', 'username'].sort()
      );
      expectNoSecretValues(safe);
    }
  });

  it('defaults to public scope', () => {
    expect('email' in toSafeUser(fullUser)!).toBe(false);
  });

  it('maps _id to id when id is absent', () => {
    const safe = toSafeUser({ _id: { toString: () => 'oid-1' }, name: 'X', username: 'x' } as never);
    expect(safe!.id).toBe('oid-1');
  });

  it('returns null for null/undefined input', () => {
    expect(toSafeUser(null)).toBeNull();
    expect(toSafeUser(undefined)).toBeNull();
  });

  it('toSafeUsers drops null entries', () => {
    const out = toSafeUsers([fullUser, null, undefined], 'public');
    expect(out).toHaveLength(1);
    expectNoSecretValues(out);
  });
});

describe('redactUserSecretsForSelf', () => {
  it('drops pure-secret fields entirely', () => {
    const self = redactUserSecretsForSelf(fullUser)!;
    for (const f of [
      'password',
      'oauthCredentials',
      'authProviders',
      'resetPasswordToken',
      'emailVerificationToken',
      'pendingEmailToken',
      'securityQuestions',
      'stripeCustomerId',
      'loginRecords',
      'userNotes',
    ]) {
      expect(f in self).toBe(false);
    }
  });

  it('keeps non-secret profile fields', () => {
    const self = redactUserSecretsForSelf(fullUser)!;
    expect(self.name).toBe('Jane Doe');
    expect(self.email).toBe('jane@example.com');
    expect(self.phone).toBe('+15551234567');
  });

  it('redacts integration TOKEN subfields but keeps status the settings UI needs', () => {
    const self = redactUserSecretsForSelf(fullUser)!;

    const mfa = self.mfa as Record<string, unknown>;
    expect(mfa.totpEnabled).toBe(true);
    expect('totpSecret' in mfa).toBe(false);
    expect('backupCodes' in mfa).toBe(false);

    const gd = self.googleDrive as Record<string, unknown>;
    expect(gd.expiresAt).toBeDefined();
    expect('accessToken' in gd).toBe(false);
    expect('refreshToken' in gd).toBe(false);

    const atl = self.atlassianConnect as Record<string, unknown>;
    expect(atl.siteName).toBe('acme');
    expect(atl.status).toBe('connected');
    expect('accessToken' in atl).toBe(false);
    expect('refreshToken' in atl).toBe(false);

    const notion = self.notionConnect as Record<string, unknown>;
    expect(notion.workspaceName).toBe('WS');
    expect('accessToken' in notion).toBe(false);

    const slack = self.slackSettings as Record<string, unknown>;
    expect(slack.slackUserId).toBe('U1');
    expect('slackUserToken' in slack).toBe(false);

    const blog = self.blogIntegration as Record<string, unknown>;
    expect(blog.baseUrl).toBe('https://blog');
    expect('apiKey' in blog).toBe(false);
  });

  it('excludes every secret value from the serialized self-view', () => {
    expectNoSecretValues(redactUserSecretsForSelf(fullUser));
  });

  it('re-includes fields listed in the keep option (for tightly-scoped callers)', () => {
    const kept = redactUserSecretsForSelf(fullUser, { keep: ['securityQuestions', 'userNotes'] })!;
    expect(kept.securityQuestions).toBeDefined();
    expect(kept.userNotes).toBeDefined();
    // credentials are still stripped even with a keep list
    expect('password' in kept).toBe(false);
    expect('resetPasswordToken' in kept).toBe(false);
    expect('stripeCustomerId' in kept).toBe(false);
  });

  it('returns null for null/undefined input', () => {
    expect(redactUserSecretsForSelf(null)).toBeNull();
    expect(redactUserSecretsForSelf(undefined)).toBeNull();
  });

  it('normalizes a Mongoose-style document via toJSON before redacting', () => {
    const doc = { toJSON: () => fullUser };
    const self = redactUserSecretsForSelf(doc as never)!;
    expect(self.name).toBe('Jane Doe');
    expect('password' in self).toBe(false);
    expectNoSecretValues(self);
  });

  // Invariants that keep the drop-all-then-rebuild guarantee honest: any secret that
  // is NOT a rebuilt integration object must be dropped whole, so a future secret
  // added to USER_SECRET_FIELDS without a rebuild block can never pass through.
  it('USER_SUBFIELD_REDACTED_FIELDS is a strict subset of USER_SECRET_FIELDS', () => {
    const secrets = new Set<string>(USER_SECRET_FIELDS);
    for (const f of USER_SUBFIELD_REDACTED_FIELDS) {
      expect(secrets.has(f)).toBe(true);
    }
  });

  it('drops every non-rebuilt USER_SECRET_FIELDS entry present on the input', () => {
    const self = redactUserSecretsForSelf(fullUser)!;
    const rebuilt = new Set<string>(USER_SUBFIELD_REDACTED_FIELDS);
    for (const f of USER_SECRET_FIELDS) {
      if (!rebuilt.has(f)) expect(f in self).toBe(false);
    }
  });
});
