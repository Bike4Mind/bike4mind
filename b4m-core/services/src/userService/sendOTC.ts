import { randomInt, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

/** OTC codes expire after 10 minutes */
export const OTC_EXPIRY_MS = 10 * 60 * 1000;

const sendOTCSchema = z.object({
  email: z.string().email(),
});

export type SendOTCParameters = z.infer<typeof sendOTCSchema>;

interface SendOTCAdapters {
  mailer: {
    sendOTCEmail: (email: string, code: string) => Promise<void>;
  };
  /**
   * Signs a short-lived JWT containing the hashed OTC + email.
   * Used for all users so the response shape never reveals
   * whether an account exists (prevents user enumeration).
   */
  signPendingToken: (payload: { email: string; otcHash: string; attempts: number; exp: number; jti: string }) => string;
}

export interface SendOTCResult {
  /**
   * Signed JWT containing the hashed OTC. Always returned regardless
   * of whether the user exists (prevents user enumeration).
   */
  pendingToken: string;
  /** Nonce embedded in the token, for server-side tracking */
  nonce: string;
  /**
   * The plaintext OTC that was emailed. The route persists this ONLY on non-production
   * stages (gated by isE2EEnabled) for the test-only otc-code endpoint; it is never
   * returned in the HTTP response.
   */
  code: string;
}

/**
 * Generates a 6-digit OTC and emails the code. The hashed code is carried in
 * the signed pending token rather than stored in the DB, so this never touches
 * the database - issuance is uniform regardless of whether an account exists
 * (OWASP user enumeration prevention).
 */
export const sendOTC = async (
  params: SendOTCParameters,
  { mailer, signPendingToken }: SendOTCAdapters
): Promise<SendOTCResult> => {
  const { email } = sendOTCSchema.parse(params);
  const normalizedEmail = email.toLowerCase().trim();

  // Generate a 6-digit numeric code
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const hashedCode = await bcrypt.hash(code, 10);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTC_EXPIRY_MS);

  // Always send the email and return a pendingToken - identical response
  // shape regardless of user existence (prevents enumeration).
  await mailer.sendOTCEmail(normalizedEmail, code);

  const nonce = randomUUID();
  const pendingToken = signPendingToken({
    email: normalizedEmail,
    otcHash: hashedCode,
    attempts: 0,
    exp: Math.floor(expiresAt.getTime() / 1000),
    jti: nonce,
  });

  return { pendingToken, nonce, code };
};
