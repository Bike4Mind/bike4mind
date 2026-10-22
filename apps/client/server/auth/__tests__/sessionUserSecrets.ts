import { expect } from 'vitest';

// Secrets a user document can carry. Keep in sync with selfUserResponseSchema and
// redactUserSecretsForSelf in @bike4mind/common. Route tests stub the redactor to identity,
// so the response schema alone has to drop these.
export const SECRET_USER_FIELDS = {
  password: 'bcrypt_secret_value',
  passwordHash: 'hash_secret_value',
  oauthCredentials: { github: 'ghp_secret_value' },
  securityQuestions: [{ question: 'first pet', answer: 'mittens' }],
  loginRecords: [{ ip: '203.0.113.7' }],
  authProviders: [{ id: 'goog-sub-1', strategy: 'google', accessToken: 'ya29.secret_value' }],
  googleDrive: { accessToken: 'gd_secret_value', refreshToken: 'gd_refresh_value', expiresAt: 123 },
  mfa: { totpEnabled: true, secret: 'totp_secret_value', backupCodes: ['backup_secret_value'] },
  notInSchema: 'undeclared_secret_value',
};

const SECRET_VALUES = [
  'bcrypt_secret_value',
  'hash_secret_value',
  'ghp_secret_value',
  'mittens',
  '203.0.113.7',
  'ya29.secret_value',
  'gd_secret_value',
  'gd_refresh_value',
  'totp_secret_value',
  'backup_secret_value',
  'undeclared_secret_value',
];

/**
 * Asserts a response carrying a user seeded with SECRET_USER_FIELDS exposes only the
 * allow-listed shape. `user` is the user object inside the body (the body itself for
 * flat responses); `body` is the whole response, checked for leaked values anywhere.
 */
export function expectSelfUserStripped(user: Record<string, unknown>, body: unknown) {
  expect(user).toHaveProperty('id');
  for (const key of [
    'password',
    'passwordHash',
    'oauthCredentials',
    'securityQuestions',
    'loginRecords',
    'notInSchema',
  ]) {
    expect(user).not.toHaveProperty(key);
  }
  expect(user.authProviders).toEqual([{ id: 'goog-sub-1', strategy: 'google' }]);
  expect(user.googleDrive).toEqual({ expiresAt: 123 });
  expect(user.mfa).toEqual({ totpEnabled: true });
  const serialized = JSON.stringify(body);
  for (const secret of SECRET_VALUES) expect(serialized).not.toContain(secret);
}
