import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { COSEALG, isoBase64URL } from '@simplewebauthn/server/helpers';
import type {
  IPasskeyChallengeRepository,
  IPasskeyCredential,
  IPasskeyCredentialRepository,
  IUserDocument,
  IUserRepository,
} from '@bike4mind/common';
import { generateBackupCodes, hashBackupCode, userHasMFAConfigured } from './utils';

export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};

export const MAX_PASSKEYS_PER_USER = 10;
/** Browser-side ceremony timeout (ms). Must stay under PASSKEY_CHALLENGE_TTL_MS in the database package. */
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
// Pinned rather than the library default, which probes for experimental PQC algorithm support
// at runtime and logs a Node ExperimentalWarning on every ceremony.
const SUPPORTED_ALGORITHM_IDS = [COSEALG.EdDSA, COSEALG.ES256, COSEALG.RS256];

export type PasskeyErrorCode =
  | 'mfa_not_enabled'
  | 'limit_reached'
  | 'no_passkeys'
  | 'challenge_expired'
  | 'unknown_credential'
  | 'already_registered'
  | 'verification_failed';

export class PasskeyError extends Error {
  constructor(
    message: string,
    readonly code: PasskeyErrorCode
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

export interface PasskeyRelyingParty {
  rpID: string;
  rpName: string;
  origin: string;
}

/**
 * The relying party is pinned to the configured app URL, never to request headers: a
 * header-derived origin would let a proxied phishing page pass the origin check, which is
 * the whole point of using passkeys.
 */
export function resolvePasskeyRelyingParty(appUrl: string | undefined, rpName: string): PasskeyRelyingParty {
  if (!appUrl) throw new Error('APP_URL must be set to use passkeys.');
  const url = new URL(appUrl);
  return { rpID: url.hostname, rpName: rpName || url.hostname, origin: url.origin };
}

export interface PasskeyDeps {
  credentials: IPasskeyCredentialRepository;
  challenges: IPasskeyChallengeRepository;
}

/**
 * A passkey is a factor in its own right: the first one enrolled turns MFA on, exactly as
 * confirming an authenticator app does. Callers gate who may enroll (see the register routes).
 */
export async function startPasskeyRegistration(
  { user, rp }: { user: IUserDocument; rp: PasskeyRelyingParty },
  { credentials, challenges }: PasskeyDeps
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await credentials.listByUser(user.id);
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw new PasskeyError(`You can register at most ${MAX_PASSKEYS_PER_USER} passkeys.`, 'limit_reached');
  }

  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email || user.username,
    userDisplayName: user.name || user.username || '',
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({ id: c.credentialId, transports: c.transports })),
    // Discoverable credentials keep the door open for passwordless sign-in later without re-enrollment.
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    timeout: CEREMONY_TIMEOUT_MS,
    supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
  });
  await challenges.issue(user.id, 'registration', options.challenge);
  return options;
}

export interface FinishPasskeyRegistrationResult {
  credential: IPasskeyCredential;
  /**
   * True when this passkey turned MFA on (the user had no factor before). The caller must then
   * do what confirming an authenticator app does: rotate sessions, audit, record the enrollment.
   */
  firstFactor: boolean;
  /** Plaintext backup codes issued with a first-factor passkey, shown once; null otherwise. */
  backupCodes: string[] | null;
}

export async function finishPasskeyRegistration(
  {
    user,
    rp,
    response,
    name,
  }: { user: IUserDocument; rp: PasskeyRelyingParty; response: RegistrationResponseJSON; name?: string },
  {
    credentials,
    challenges,
    users,
  }: PasskeyDeps & { users: Pick<IUserRepository, 'atomicEnablePasskeyMfa' | 'update'> }
): Promise<FinishPasskeyRegistrationResult> {
  const expectedChallenge = await challenges.consume(user.id, 'registration');
  if (!expectedChallenge) {
    throw new PasskeyError('Passkey registration timed out. Please try again.', 'challenge_expired');
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    });
  } catch {
    throw new PasskeyError('Passkey registration could not be verified.', 'verification_failed');
  }
  if (!verification.verified) {
    throw new PasskeyError('Passkey registration could not be verified.', 'verification_failed');
  }

  if ((await credentials.countByUser(user.id)) >= MAX_PASSKEYS_PER_USER) {
    throw new PasskeyError(`You can register at most ${MAX_PASSKEYS_PER_USER} passkeys.`, 'limit_reached');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  let created: IPasskeyCredential;
  try {
    created = await credentials.create({
      userId: user.id,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? response.response.transports,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name: name?.trim() || 'Passkey',
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === 11000) {
      throw new PasskeyError('This passkey is already registered.', 'already_registered');
    }
    throw error;
  }

  if (!userHasMFAConfigured(user)) {
    // Backup codes are the passkey-only user's recovery path when the device is lost, the same
    // as for an app user. Null means a concurrent enrollment turned MFA on first.
    const backupCodes = generateBackupCodes();
    if (await users.atomicEnablePasskeyMfa(user.id, backupCodes.map(hashBackupCode))) {
      return { credential: created, firstFactor: true, backupCodes };
    }
  }
  if (!user.mfa?.passkeyEnabled) {
    await users.update({ id: user.id, 'mfa.passkeyEnabled': true, updatedAt: new Date() });
  }
  return { credential: created, firstFactor: false, backupCodes: null };
}

export async function startPasskeyAuthentication(
  { userId, rp }: { userId: string; rp: PasskeyRelyingParty },
  { credentials, challenges }: PasskeyDeps
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const existing = await credentials.listByUser(userId);
  if (existing.length === 0) {
    throw new PasskeyError('No passkeys are registered for this account.', 'no_passkeys');
  }
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: existing.map(c => ({ id: c.credentialId, transports: c.transports })),
    userVerification: 'preferred',
    timeout: CEREMONY_TIMEOUT_MS,
  });
  await challenges.issue(userId, 'authentication', options.challenge);
  return options;
}

/** Satisfy the MFA challenge (or a step-up) with a passkey. */
export async function finishPasskeyAuthentication(
  { user, rp, response }: { user: IUserDocument; rp: PasskeyRelyingParty; response: AuthenticationResponseJSON },
  { credentials, challenges, users }: PasskeyDeps & { users: Pick<IUserRepository, 'update'> }
): Promise<{ user: IUserDocument; credentialId: string }> {
  if (!userHasMFAConfigured(user)) {
    throw new PasskeyError('MFA is not enabled for this user.', 'mfa_not_enabled');
  }
  const expectedChallenge = await challenges.consume(user.id, 'authentication');
  if (!expectedChallenge) {
    throw new PasskeyError('Passkey sign-in timed out. Please try again.', 'challenge_expired');
  }
  const stored = await credentials.findByCredentialId(user.id, response.id);
  if (!stored) {
    throw new PasskeyError('This passkey is not registered for this account.', 'unknown_credential');
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: {
        id: stored.credentialId,
        publicKey: isoBase64URL.toBuffer(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports,
      },
      requireUserVerification: false,
    });
  } catch {
    // Includes a signature-counter regression, which the library treats as a cloned authenticator.
    throw new PasskeyError('Passkey could not be verified.', 'verification_failed');
  }
  if (!verification.verified) {
    throw new PasskeyError('Passkey could not be verified.', 'verification_failed');
  }

  await credentials.recordUse(stored.id, verification.authenticationInfo.newCounter);

  // Field-level write, as in verifyMFA: a passkey-only user has no totpSecret, so a whole-`mfa`
  // write would be dropped by the user model's secret-less guard and the lockout never cleared.
  const updatedUser = await users.update(
    { id: user.id, 'mfa.failedAttempts': 0, 'mfa.lastUsedAt': new Date(), updatedAt: new Date() },
    { unset: ['mfa.lastFailedAttempt', 'mfa.lockedUntil'] }
  );
  if (!updatedUser) {
    throw new Error('Failed to update user MFA data');
  }
  return { user: updatedUser, credentialId: stored.id };
}
