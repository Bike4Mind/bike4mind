import type { Response } from 'express';
import * as z from 'zod';
import type { IPasskeyCredential, IUserDocument } from '@bike4mind/common';
import { mfaService } from '@bike4mind/services';
import { passkeyChallengeRepository, passkeyCredentialRepository } from '@bike4mind/database';
import { readSignInOrigin } from '@server/auth/signInSecondFactor';

export const passkeyDeps = { credentials: passkeyCredentialRepository, challenges: passkeyChallengeRepository };

export const getPasskeyRelyingParty = () =>
  mfaService.resolvePasskeyRelyingParty(process.env.APP_URL, process.env.APP_NAME || '');

const STATUS_BY_CODE: Record<mfaService.PasskeyErrorCode, number> = {
  mfa_not_enabled: 400,
  limit_reached: 409,
  no_passkeys: 404,
  challenge_expired: 400,
  unknown_credential: 400,
  already_registered: 409,
  verification_failed: 400,
};

/**
 * Matched by name + code rather than `instanceof`: the class can be loaded twice (ESM and CJS
 * builds of the auth package), and an identity check would then miss it.
 */
export function asPasskeyError(
  error: unknown
): { message: string; code: mfaService.PasskeyErrorCode; status: number } | null {
  if (!(error instanceof Error) || error.name !== 'PasskeyError') return null;
  const code = (error as { code?: unknown }).code as mfaService.PasskeyErrorCode;
  const status = STATUS_BY_CODE[code];
  return status ? { message: error.message, code, status } : null;
}

/** Sends a ceremony error as its mapped status; rethrows anything that is not one. */
export function sendPasskeyError(res: Response, error: unknown): Response {
  const passkeyError = asPasskeyError(error);
  if (!passkeyError) throw error;
  return res.status(passkeyError.status).json({ error: passkeyError.message, code: passkeyError.code });
}

/**
 * Why this request may not enroll a passkey, or null when it may. `credential` is req.user (the
 * token's view: mfaPending, sign-in origin); `user` is the fresh database read.
 * - A pending token whose user already has a factor owes the challenge, not an enrollment: the
 *   register routes are reachable pre-challenge only so a first factor can be enrolled.
 * - Emergency sign-in never enrolls a first factor, matching the app setup route.
 */
export function refusePasskeyEnrollment(credential: unknown, user: IUserDocument): string | null {
  const configured = mfaService.userHasMFAConfigured(user);
  if (configured && (credential as { mfaPending?: unknown } | undefined)?.mfaPending) {
    return 'Complete two-step verification before adding a passkey.';
  }
  if (!configured && readSignInOrigin(credential)?.createdVia === 'emergency') {
    return 'Passkey enrollment is not available during emergency sign-in.';
  }
  return null;
}

export const toPasskeySummary = (credential: IPasskeyCredential) => ({
  id: credential.id,
  name: credential.name,
  deviceType: credential.deviceType,
  backedUp: credential.backedUp,
  createdAt: credential.createdAt,
  lastUsedAt: credential.lastUsedAt ?? null,
});

// The browser library's JSON shapes. Only the envelope is checked here; the ceremony
// verification does the real (cryptographic) validation of every field.
const credentialEnvelope = {
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
};

export const registrationResponseSchema = z.looseObject({
  ...credentialEnvelope,
  response: z.looseObject({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
    transports: z.array(z.string()).optional(),
  }),
});

export const authenticationResponseSchema = z.looseObject({
  ...credentialEnvelope,
  response: z.looseObject({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().optional(),
  }),
});
