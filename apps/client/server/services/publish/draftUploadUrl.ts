import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Config } from '@server/utils/config';

/**
 * Draft-upload URL minting for step 2 of the publish flow.
 *
 * Hosted: the browser PUTs bundle bytes straight to S3 via a short-lived
 * presigned URL. Self-host has no browser-reachable object store (MinIO listens
 * on an internal compose hostname, so its presigned URLs are unresolvable from a
 * browser), so instead the app proxies the upload: mint returns a same-origin
 * `/api/publish/artifact/draft-upload` URL carrying a signed capability token,
 * and the route (draft-upload.ts) streams the bytes into storage under the same
 * `drafts/{draftId}/{path}` key finalize.ts reads.
 *
 * The token is the ONLY auth the proxy route requires (it is otherwise
 * anonymous, mirroring how a presigned URL is itself an unauthenticated
 * capability URL). Audience-scoping + a pinned {draftId, path} claim, same
 * pattern as publishGateToken, bound what a leaked token can do to exactly the
 * one draft key it was minted for.
 */
const DRAFT_UPLOAD_TOKEN_AUDIENCE = 'publish-draft-upload';

/** Proxy-token validity window (seconds). Mirrors the presigned URL expiry in
 *  upload-url.ts so a self-host token expires exactly when a hosted presigned
 *  URL would; both are surfaced to the client as the draft's `expiresAt`. */
export const DRAFT_UPLOAD_EXPIRY_SECONDS = 600;

const DraftUploadClaimsSchema = z.object({
  draftId: z.string().min(1),
  path: z.string().min(1),
});

export type DraftUploadClaims = z.infer<typeof DraftUploadClaimsSchema>;

/** Sign a proxy-upload token. `expiresInSeconds` is threaded so the token TTL is
 *  the single source of truth with the presigned-URL expiry / advertised
 *  `expiresAt` (mintDraftUploadUrl passes the same value it uses everywhere). The
 *  HS256 algorithm is pinned to foreclose alg-confusion on verify. */
export function signDraftUploadToken(
  claims: DraftUploadClaims,
  expiresInSeconds: number = DRAFT_UPLOAD_EXPIRY_SECONDS
): string {
  const payload = DraftUploadClaimsSchema.parse(claims);
  return jwt.sign(payload, Config.JWT_SECRET, {
    algorithm: 'HS256',
    audience: DRAFT_UPLOAD_TOKEN_AUDIENCE,
    expiresIn: expiresInSeconds,
  });
}

/** Verify a proxy-upload token; returns the pinned claims or null (an invalid,
 *  expired, or wrong-audience token simply means the upload is rejected). The
 *  accepted algorithm is pinned to HS256 (no alg confusion). */
export function verifyDraftUploadToken(token: string): DraftUploadClaims | null {
  try {
    const decoded = jwt.verify(token, Config.JWT_SECRET, {
      algorithms: ['HS256'],
      audience: DRAFT_UPLOAD_TOKEN_AUDIENCE,
    });
    return DraftUploadClaimsSchema.parse(decoded);
  } catch {
    return null;
  }
}

/** Minimal storage surface mintDraftUploadUrl needs for the hosted path -
 *  satisfied structurally by S3Storage (fab-pipeline), so this module stays
 *  decoupled from the concrete storage class and is trivial to unit-test. */
export interface DraftUploadStorage {
  getSignedUrl(path: string, method: 'put', options: { expiresIn: number; ContentType: string }): Promise<string>;
}

export interface MintDraftUploadUrlInput {
  storage: DraftUploadStorage;
  /** Full storage key, e.g. `drafts/{draftId}/{path}` (used by the hosted presigned PUT). */
  key: string;
  draftId: string;
  path: string;
  mimeType: string;
  expiresIn: number;
}

/**
 * Return the URL the browser PUTs a single draft file to. Hosted: a presigned S3
 * PUT (unchanged behavior). Self-host: a same-origin proxy URL with a signed
 * token. The browser PUT itself is identical in both cases (publishApi.ts).
 */
export async function mintDraftUploadUrl(input: MintDraftUploadUrlInput): Promise<string> {
  if (process.env.B4M_SELF_HOST === 'true') {
    const token = signDraftUploadToken({ draftId: input.draftId, path: input.path }, input.expiresIn);
    const params = new URLSearchParams({ draftId: input.draftId, path: input.path, token });
    return `/api/publish/artifact/draft-upload?${params.toString()}`;
  }
  return input.storage.getSignedUrl(input.key, 'put', {
    expiresIn: input.expiresIn,
    ContentType: input.mimeType,
  });
}
