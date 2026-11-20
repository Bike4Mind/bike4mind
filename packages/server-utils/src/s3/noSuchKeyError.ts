/**
 * A storage read that failed because the OBJECT (not the bucket) does not exist (vs a transient
 * 5xx/throttle): S3's GetObject throws `NoSuchKey` for a key that was never written or was deleted.
 * Matched by the error's `name`/`Code` only - deliberately NOT by a bare `$metadata.httpStatusCode === 404`,
 * because the AWS SDK maps `NoSuchBucket` to 404 identically, and a bucket misconfig (stage-name
 * substitution miss, a self-host `.env` typo) must be treated as transient, never as a gone object.
 * Matches the AWS SDK v3 error shape structurally so callers needn't import the S3 client.
 *
 * Stricter than `isMissingObjectError` in utils/accountDataExport, which also accepts HeadObject's
 * bare `NotFound`.
 */
export function isNoSuchKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; Code?: string };
  return e.name === 'NoSuchKey' || e.Code === 'NoSuchKey';
}
