import { createHmac, timingSafeEqual } from 'crypto';
import { FILE_URL_TTL_SECONDS, fileUrlSigningDate } from './signedUrlWindow';

/**
 * Capability token for the stable file content URL (`/api/files/{id}/content?exp=&sig=`).
 * HMAC-SHA256 over the file id, its storage path and the expiry, so a link stops working once the
 * file moves. The key is passed in (packages/server-utils/src/files/browserFileSigner.ts derives it).
 * User-less, cacheable browser link: no access re-check, the sig is the capability. For the per-user
 * email/Slack link that re-checks access on redemption, see packages/server-utils/src/files/fileLinkToken.ts.
 */

const FILE_ID_SHAPE = /^[0-9a-f]{24}$/;
// Canonical digits only: the MAC covers Number(exp), so a leading zero would be a second spelling.
const EXP_SHAPE = /^[1-9]\d{0,11}$/;
const SIG_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface FileContentClaims {
  fileId: string;
  filePath: string;
  /** Unix seconds. */
  exp: number;
}

/** Expiry for a link minted at `now`: the same for every instance and read inside one signing window. */
export const fileContentExp = (now: Date = new Date()): number =>
  Math.floor(fileUrlSigningDate(now).getTime() / 1000) + FILE_URL_TTL_SECONDS;

const mac = (key: Buffer, { fileId, filePath, exp }: FileContentClaims): string =>
  createHmac('sha256', key).update(`v1|${fileId}|${filePath}|${exp}`).digest('base64url');

export const mintFileContentSig = (claims: FileContentClaims, key: Buffer): string => mac(key, claims);

export type FileContentSigCheck =
  { ok: true; exp: number } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/** Shape, then MAC (constant time), then expiry. `exp` and `sig` are the raw query values. */
export const verifyFileContentSig = (
  input: { fileId: unknown; filePath: unknown; exp: unknown; sig: unknown },
  key: Buffer,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): FileContentSigCheck => {
  const { fileId, filePath, exp, sig } = input;
  if (
    typeof fileId !== 'string' ||
    typeof filePath !== 'string' ||
    typeof exp !== 'string' ||
    typeof sig !== 'string' ||
    !FILE_ID_SHAPE.test(fileId) ||
    filePath.length === 0 ||
    !EXP_SHAPE.test(exp) ||
    !SIG_SHAPE.test(sig)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const expSeconds = Number(exp);
  const expected = Buffer.from(mac(key, { fileId, filePath, exp: expSeconds }));
  if (!timingSafeEqual(expected, Buffer.from(sig))) return { ok: false, reason: 'bad_signature' };
  if (nowSeconds >= expSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, exp: expSeconds };
};
