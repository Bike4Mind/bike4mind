/**
 * Mail bodies too large to ride an email.send event are written under MAIL_BODY_PREFIX in the app
 * files bucket by queuedMailer (packages/server-utils/src/utils/mailer/queuedMailer.ts) and read
 * back by the email-send worker. The prefix expires after a day (appFilesBucketLifecycle in
 * infra/buckets.ts). Imports nothing from buckets.ts so buckets.ts can use it without a cycle.
 */

// Must stay in sync with MAIL_BODY_PREFIX in packages/server-utils/src/utils/mailer/mailBodyStore.ts.
export const MAIL_BODY_PREFIX = 'queued-mail/';

type Bucket = { name: $util.Input<string>; arn: $util.Input<string> };

export const mailBodyEnvironment = (bucket: Bucket) => ({ MAIL_BODY_BUCKET: bucket.name });

// Object-level grants on the prefix only, not a bucket link (which would grant the whole bucket).
export const mailBodyPutPermission = (bucket: Bucket) => ({
  actions: ['s3:PutObject'],
  resources: [$interpolate`${bucket.arn}/${MAIL_BODY_PREFIX}*`],
});

export const mailBodyGetPermission = (bucket: Bucket) => ({
  actions: ['s3:GetObject'],
  resources: [$interpolate`${bucket.arn}/${MAIL_BODY_PREFIX}*`],
});
