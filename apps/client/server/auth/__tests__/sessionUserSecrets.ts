import { expect } from 'vitest';
import { USER_SECRET_FIELDS, USER_SUBFIELD_REDACTED_FIELDS } from '@bike4mind/common';

const SECRET_VALUE = 'session-user-secret-sentinel';

/**
 * A user document carrying every secret family, plus an undeclared key. Route tests stub
 * the redactor to identity, so the response schema alone must strip all of them, including
 * future additions to USER_SECRET_FIELDS (the `satisfies` makes an unseeded one a type error).
 *
 * A factory, not a constant: routes mutate the doc they are handed (OTC unshifts a login
 * record), so every caller needs its own nested objects.
 */
export function secretUserFields() {
  return {
    password: SECRET_VALUE,
    passwordHash: SECRET_VALUE,
    oauthCredentials: { github: SECRET_VALUE },
    securityQuestions: [{ question: 'first pet', answer: SECRET_VALUE }],
    loginRecords: [{ ip: SECRET_VALUE }],
    signupMeta: { ip: SECRET_VALUE },
    freeCreditClaimEmail: SECRET_VALUE,
    signupGrantAssessment: { policyVersion: SECRET_VALUE },
    authProviders: [
      {
        id: 'goog-sub-1',
        strategy: 'google',
        accessToken: SECRET_VALUE,
        refreshToken: SECRET_VALUE,
        futureField: SECRET_VALUE,
      },
    ],
    googleDrive: { accessToken: SECRET_VALUE, refreshToken: SECRET_VALUE, expiresAt: 123, futureField: SECRET_VALUE },
    mfa: { totpEnabled: true, totpSecret: SECRET_VALUE, backupCodes: [SECRET_VALUE], futureField: SECRET_VALUE },
    totpLastStep: 123,
    atlassianConnect: {
      siteName: 'test-site',
      accessToken: SECRET_VALUE,
      refreshToken: SECRET_VALUE,
      futureField: SECRET_VALUE,
    },
    notionConnect: { workspaceId: 'w1', accessToken: SECRET_VALUE, botId: SECRET_VALUE, futureField: SECRET_VALUE },
    blogIntegration: { baseUrl: 'https://example.com', apiKey: SECRET_VALUE, futureField: SECRET_VALUE },
    slackSettings: {
      slackUserId: 'U1',
      slackUserToken: SECRET_VALUE,
      slackUserScopes: [SECRET_VALUE],
      lastUsedAgent: SECRET_VALUE,
      futureField: SECRET_VALUE,
    },
    resetPasswordToken: SECRET_VALUE,
    resetPasswordSentAt: new Date('2026-01-01'),
    resetPasswordExpires: new Date('2026-01-02'),
    emailVerificationToken: SECRET_VALUE,
    emailVerificationSentAt: new Date('2026-01-01'),
    emailVerificationExpires: new Date('2026-01-02'),
    pendingEmailToken: SECRET_VALUE,
    pendingEmailSentAt: new Date('2026-01-01'),
    pendingEmailExpires: new Date('2026-01-02'),
    pendingNotionOAuthNonce: SECRET_VALUE,
    userNotes: SECRET_VALUE,
    stripeCustomerId: SECRET_VALUE,
    riskScore: { score: 90, signals: [{ signal: 'quickApiKey', points: 15, reason: SECRET_VALUE }] },
    notInSchema: SECRET_VALUE,
  } satisfies Record<(typeof USER_SECRET_FIELDS)[number] | 'passwordHash' | 'notInSchema', unknown>;
}

const EXPECTED_REDACTED_FIELDS = {
  authProviders: [{ id: 'goog-sub-1', strategy: 'google' }],
  googleDrive: { expiresAt: 123 },
  mfa: { totpEnabled: true },
  atlassianConnect: { siteName: 'test-site' },
  notionConnect: { workspaceId: 'w1' },
  blogIntegration: { baseUrl: 'https://example.com' },
  slackSettings: { slackUserId: 'U1' },
} satisfies Record<(typeof USER_SUBFIELD_REDACTED_FIELDS)[number], unknown>;

const SUBFIELD_REDACTED_FIELDS: ReadonlySet<string> = new Set(USER_SUBFIELD_REDACTED_FIELDS);

/**
 * Asserts a response carrying a user seeded with `secretUserFields()` exposes only the
 * allow-listed shape. `user` is the user object inside the body (the body itself for flat
 * responses), `expectedId` the id of the user that must come back, and `body` the whole
 * response, checked for leaked values anywhere.
 */
export function expectSelfUserStripped(user: Record<string, unknown>, body: unknown, expectedId: string) {
  expect(user.id).toBe(expectedId);
  for (const key of [...USER_SECRET_FIELDS, 'passwordHash', 'notInSchema']) {
    if (SUBFIELD_REDACTED_FIELDS.has(key)) continue;
    expect(user).not.toHaveProperty(key);
  }
  for (const [key, expected] of Object.entries(EXPECTED_REDACTED_FIELDS)) {
    expect(user[key]).toEqual(expected);
  }
  expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
}
