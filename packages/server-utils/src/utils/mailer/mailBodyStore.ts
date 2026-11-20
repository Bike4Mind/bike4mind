import { randomUUID } from 'crypto';

/**
 * Where queuedMailer parks a mail body too large to ride an email.send event, for the email-send
 * worker to read back. MAIL_BODY_BUCKET, the grants and the 1-day expiry on the prefix come from
 * infra/mailBodyOffload.ts.
 */

// Must stay in sync with MAIL_BODY_PREFIX in infra/mailBodyOffload.ts (infra/__tests__/mailBodyOffload.test.ts).
export const MAIL_BODY_PREFIX = 'queued-mail/';
export const MAIL_BODY_KEY_PATTERN = /^queued-mail\/[0-9a-f-]{36}\.json$/;

export interface StoredMailBody {
  html: string;
  text?: string;
}

const mailBodyBucket = () => {
  const bucket = process.env.MAIL_BODY_BUCKET;
  if (!bucket) throw new Error('MAIL_BODY_BUCKET is not set');
  return bucket;
};

// ../eventBus.ts imports the key pattern from here, so the S3 SDK loads only when a body is stored or read.
// A client per call, so a long-warm container never signs with expired credentials (as ../eventBus.ts).
export async function putMailBody(body: StoredMailBody): Promise<string> {
  const Bucket = mailBodyBucket();
  const [{ PutObjectCommand }, { createS3Client }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@bike4mind/fab-pipeline'),
  ]);
  const key = `${MAIL_BODY_PREFIX}${randomUUID()}.json`;
  await createS3Client().send(
    new PutObjectCommand({ Bucket, Key: key, Body: JSON.stringify(body), ContentType: 'application/json' })
  );
  return key;
}

export async function getMailBody(key: string): Promise<StoredMailBody> {
  const Bucket = mailBodyBucket();
  const [{ GetObjectCommand }, { createS3Client }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@bike4mind/fab-pipeline'),
  ]);
  const result = await createS3Client().send(new GetObjectCommand({ Bucket, Key: key }));
  const raw = await result.Body?.transformToString();
  if (raw === undefined) throw new Error(`mail body ${key} has no content`);
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as StoredMailBody).html !== 'string' ||
    !['string', 'undefined'].includes(typeof (parsed as StoredMailBody).text)
  ) {
    throw new Error(`mail body ${key} is not a stored mail body`);
  }
  const { html, text } = parsed as StoredMailBody;
  return text === undefined ? { html } : { html, text };
}
