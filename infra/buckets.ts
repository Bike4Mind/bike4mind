import { allSecrets } from './secrets';
import { websocketApi } from './websocket';
import { domain, getAllowedOrigins, router, routePrefix, isSharedRouterConsumer } from './router';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { lambdaVpc } from './vpc';

// Bucket options:  Named buckets are named, and kept; otherwise, they're auto-deleted.
// Buckets in production and dev (staging) are retained on deletion for data safety,
//  while in other stages, they are set to auto-delete for resource cleanup.
const fabFileBucketName =
  process.env.FAB_FILES_BUCKET_NAME ||
  ($app.stage === 'production'
    ? `production-${$app.name}-buckets-fabfilesbucket`
    : $app.stage === 'dev'
      ? `dev-${$app.name}-buckets-fabfilesbucket`
      : undefined);

const generatedImagesBucketName =
  process.env.GENERATED_IMAGES_BUCKET_NAME ||
  ($app.stage === 'production'
    ? `production-${$app.name}-buckets-generatedimagesbucket`
    : $app.stage === 'dev'
      ? `dev-${$app.name}-buckets-generatedimagesbucket`
      : undefined);

const appFilesBucketName =
  process.env.APP_FILES_BUCKET_NAME ||
  ($app.stage === 'production'
    ? `production-${$app.name}-buckets-appfilesbucket`
    : $app.stage === 'dev'
      ? `dev-${$app.name}-buckets-appfilesbucket`
      : undefined);

const publishedArtifactsBucketName =
  process.env.PUBLISHED_ARTIFACTS_BUCKET_NAME ||
  ($app.stage === 'production'
    ? `production-${$app.name}-buckets-publishedartifactsbucket`
    : $app.stage === 'dev'
      ? `dev-${$app.name}-buckets-publishedartifactsbucket`
      : undefined);

// Only create What's New distribution bucket if this is the publisher (main production)
// Fork environments should NOT create this bucket - they consume via WHATS_NEW_DISTRIBUTION_URL
const isWhatsNewDistributionEnabled = process.env.ENABLE_WHATS_NEW_DISTRIBUTION === 'true';

if (!isWhatsNewDistributionEnabled) {
  console.log('INFO: ENABLE_WHATS_NEW_DISTRIBUTION not set, skipping distribution bucket (fork mode)');
}

const whatsNewDistributionBucketName = isWhatsNewDistributionEnabled
  ? process.env.WHATS_NEW_DISTRIBUTION_BUCKET_NAME ||
    ($app.stage === 'production'
      ? `production-${$app.name}-buckets-whatsnewdistributionbucket`
      : $app.stage === 'dev'
        ? `dev-${$app.name}-buckets-whatsnewdistributionbucket`
        : undefined)
  : undefined;

/**
 * ===============================
 * FabFileBucket
 */
const fabFileBucket = new sst.aws.Bucket(
  'fabFileBucket',
  {
    versioning: process.env.ENABLE_BUCKET_VERSIONING === 'true',
    transform: {
      bucket: fabFileBucketName
        ? (args, opts) => {
            args.bucket = fabFileBucketName;
            args.forceDestroy = undefined;
          }
        : undefined,
    },
  },
  {
    retainOnDelete: fabFileBucketName ? true : false,
  }
);

/**
 * ===============================
 * GeneratedImagesBucket
 * ===============================
 */
const generatedImagesBucket = new sst.aws.Bucket(
  'generatedImagesBucket',
  {
    versioning: process.env.ENABLE_BUCKET_VERSIONING === 'true',
    cors: {
      allowOrigins: getAllowedOrigins(domain),
      allowHeaders: ['*'],
      allowMethods: ['GET', 'PUT', 'POST'],
    },
    access: 'cloudfront',
    transform: {
      bucket: generatedImagesBucketName
        ? (args, opts) => {
            args.bucket = generatedImagesBucketName;
            args.forceDestroy = undefined;
          }
        : undefined,
    },
  },
  {
    retainOnDelete: generatedImagesBucketName ? true : false,
  }
);

// PARITY: these routeBucket prefixes are mirrored by resolveProxyTarget in
// apps/client/server/utils/appFileProxy.ts (the dev local-proxy path) and by
// toCdnPath in apps/client/app/utils/s3.ts. If you add/remove/rewrite a prefix
// here, update both in lockstep.
if (router && !isSharedRouterConsumer) {
  // When using shared router, namespace routes by stage to prevent conflicts
  // routePrefix is imported from router.ts

  router.routeBucket(`${routePrefix}/generated`, generatedImagesBucket, {
    rewrite: {
      regex: `^${routePrefix}/generated/(.*)$`,
      to: '/$1',
    },
  });
}

/**
 * ===============================
 * AppFilesBucket
 * ===============================
 */
const appFilesBucket = new sst.aws.Bucket(
  'appFilesBucket',
  {
    versioning: process.env.ENABLE_BUCKET_VERSIONING === 'true',
    cors: {
      allowOrigins: getAllowedOrigins(domain),
      allowHeaders: ['*'],
      allowMethods: ['GET', 'PUT', 'POST'],
    },
    access: 'cloudfront',
    transform: {
      bucket: appFilesBucketName
        ? (args, opts) => {
            args.bucket = appFilesBucketName;
            args.forceDestroy = undefined;
          }
        : undefined,
    },
  },
  {
    retainOnDelete: appFilesBucketName ? true : false,
  }
);

// Route publicly accessible directories through CloudFront
// Only these paths will be accessible via CloudFront URLs
if (router && !isSharedRouterConsumer) {
  // When using shared router, namespace routes by stage to prevent conflicts
  // routePrefix is imported from router.ts

  router.routeBucket(`${routePrefix}/proxied-images`, appFilesBucket, {
    rewrite: {
      regex: `^${routePrefix}/proxied-images/(.*)$`,
      to: '/proxied-images/$1',
    },
  });

  // Renamed from /admin/logos to avoid collision with the /admin SPA route (longest-prefix matching)
  router.routeBucket(`${routePrefix}/admin-logos`, appFilesBucket, {
    rewrite: {
      regex: `^${routePrefix}/admin-logos/(.*)$`,
      to: '/admin/logos/$1',
    },
  });

  router.routeBucket(`${routePrefix}/profile-photos`, appFilesBucket, {
    rewrite: {
      regex: `^${routePrefix}/profile-photos/(.*)$`,
      to: '/profile-photos/$1',
    },
  });

  // Use /org-files instead of /organizations to avoid collision with SPA routes
  // (/organizations/$id). The rewrite maps the CF URL path to the existing S3 key prefix.
  router.routeBucket(`${routePrefix}/org-files`, appFilesBucket, {
    rewrite: {
      regex: `^${routePrefix}/org-files/(.*)$`,
      to: '/organizations/$1',
    },
  });

  // Public settings config artifact (M2.5 — docs/perf/mobile-startup-latency.md).
  // S3 key: app-config/public-settings.json — written by the settings update handler
  // (publicSettingsArtifact.ts) and served unauthenticated so the client hydrates
  // startup config in ms. Per-object Cache-Control sets max-age/stale-while-revalidate.
  // Path /app-config does NOT collide with any Tanstack SPA route (verified).
  router.routeBucket(`${routePrefix}/app-config`, appFilesBucket, {
    rewrite: {
      regex: `^${routePrefix}/app-config/(.*)$`,
      to: '/app-config/$1',
    },
  });
}

const appFilesBucketNotification = appFilesBucket.notify({
  notifications: [
    {
      name: 'uploadComplete',
      function: {
        handler: 'apps/client/server/s3/appFileUploadComplete.func',
        runtime: 'nodejs24.x',
        link: [...allSecrets, websocketApi],
        vpc: lambdaVpc,
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
        },
        logging: {
          retention: '3 days',
        },
      },
      events: ['s3:ObjectCreated:*'],
    },
  ],
});

const historyImportBucket = new sst.aws.Bucket('historyImportBucket', {
  cors: {
    allowOrigins: getAllowedOrigins(domain),
    allowMethods: ['PUT'],
    allowHeaders: ['*'],
  },
  versioning: process.env.ENABLE_BUCKET_VERSIONING === 'true',
});

// Lifecycle policy to automatically delete old import files
const historyImportBucketLifecycle = new aws.s3.BucketLifecycleConfigurationV2('historyImportBucketLifecycle', {
  bucket: historyImportBucket.name,
  rules: [
    {
      id: 'auto-delete-old-imports',
      status: 'Enabled',
      expiration: {
        days: 7, // Delete files older than 7 days
      },
      abortIncompleteMultipartUpload: {
        daysAfterInitiation: 1, // Clean up failed uploads after 1 day
      },
    },
  ],
});

// Auto-delete per-user cc-bridge download zips. Each click mints a unique
// zip (binary + ephemeral pair.json) uploaded under `cc-bridge-downloads/`.
// The pair token inside is 5-min-TTL so the zip is useless after that, but
// we keep zips around for 1 day so slow downloads still succeed.
const appFilesBucketLifecycle = new aws.s3.BucketLifecycleConfigurationV2('appFilesBucketLifecycle', {
  bucket: appFilesBucket.name,
  rules: [
    {
      id: 'expire-cc-bridge-downloads',
      status: 'Enabled',
      filter: {
        prefix: 'cc-bridge-downloads/',
      },
      expiration: {
        days: 1,
      },
      abortIncompleteMultipartUpload: {
        daysAfterInitiation: 1,
      },
    },
    {
      // Transient audio uploads for /api/ai/transcribe. The endpoint deletes
      // the object in a finally block, but this catches orphans (client crash
      // between presigned-POST and transcribe call).
      id: 'expire-transcribe-uploads',
      status: 'Enabled',
      filter: {
        prefix: 'transcribe-uploads/',
      },
      expiration: {
        days: 1,
      },
      abortIncompleteMultipartUpload: {
        daysAfterInitiation: 1,
      },
    },
    {
      // AWS Transcribe job outputs. speechService deletes its own transcript
      // immediately after reading; this is the backstop in case a Lambda
      // freeze or unexpected error path leaves the JSON behind. These files
      // contain the user's verbatim speech, so don't keep them around longer
      // than necessary.
      id: 'expire-transcripts',
      status: 'Enabled',
      filter: {
        prefix: 'transcripts/',
      },
      expiration: {
        days: 1,
      },
      abortIncompleteMultipartUpload: {
        daysAfterInitiation: 1,
      },
    },
  ],
});

// Create Lambda functions separately so they can be linked to other resources
const uploadCompleteFunction = new sst.aws.Function('HistoryUploadCompleteFunction', {
  handler: 'apps/client/server/s3/historyUploadComplete.dispatch',
  runtime: 'nodejs24.x',
  link: [...allSecrets, historyImportBucket, websocketApi],
  vpc: lambdaVpc,
  timeout: '15 minutes', // Maximum Lambda timeout for large file processing
  memory: '3008 MB', // Increased memory for large file imports (up to 1GB)
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  logging: {
    retention: '3 days',
  },
});

const notebookImportFunction = new sst.aws.Function('NotebookImportCompleteFunction', {
  handler: 'apps/client/server/s3/notebookImportComplete.dispatch',
  runtime: 'nodejs24.x',
  link: [...allSecrets, fabFileBucket, appFilesBucket, generatedImagesBucket, historyImportBucket, websocketApi],
  vpc: lambdaVpc,
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
  logging: {
    retention: '3 days',
  },
  timeout: '5 minutes', // Longer timeout for large imports
  memory: '1024 MB', // More memory for processing
});

// Now use the created functions in bucket notifications
const historyImportBucketNotification = historyImportBucket.notify({
  notifications: [
    {
      name: 'uploadComplete',
      function: uploadCompleteFunction.arn,
      events: ['s3:ObjectCreated:*'],
      // This will handle OpenAI/Claude imports (without notebooks/ prefix)
      filterSuffix: '.zip',
    },
    {
      name: 'notebookImportCompleted',
      function: notebookImportFunction.arn,
      events: ['s3:ObjectCreated:*'],
      filterPrefix: 'notebooks/', // Only trigger for notebook imports
      filterSuffix: '.json', // Only process JSON files, not options files
    },
  ],
});

/**
 * ===============================
 * SlackExportBucket
 * ===============================
 * Temporary storage for async Slack channel exports
 * Files are auto-deleted after 7 days
 */
const slackExportBucket = new sst.aws.Bucket('slackExportBucket', {
  cors: {
    allowOrigins: getAllowedOrigins(domain),
    allowMethods: ['GET'],
    allowHeaders: ['*'],
  },
  versioning: false, // No versioning needed for temporary exports
});

// Lifecycle policy to automatically delete old export files
const slackExportBucketLifecycle = new aws.s3.BucketLifecycleConfigurationV2('slackExportBucketLifecycle', {
  bucket: slackExportBucket.name,
  rules: [
    {
      id: 'auto-delete-old-exports',
      status: 'Enabled',
      expiration: {
        days: 7, // Delete files older than 7 days
      },
      abortIncompleteMultipartUpload: {
        daysAfterInitiation: 1, // Clean up failed uploads after 1 day
      },
    },
  ],
});

/**
 * ===============================
 * WhatsNewDistributionBucket
 * ===============================
 * Public bucket for distributing What's New modals to fork environments.
 * Production uploads modals here; fork environments fetch via CloudFront.
 * Versioning enabled for rollback capability.
 *
 * Only created when ENABLE_WHATS_NEW_DISTRIBUTION=true (main production only).
 * Fork environments should NOT create this bucket.
 */
const whatsNewDistributionBucket = isWhatsNewDistributionEnabled
  ? new sst.aws.Bucket(
      'whatsNewDistributionBucket',
      {
        versioning: true, // Keep version history for rollback
        cors: {
          allowOrigins: getAllowedOrigins(domain),
          allowHeaders: ['*'],
          allowMethods: ['GET', 'HEAD'],
        },
        access: 'cloudfront', // Secure via CloudFront OAC (Origin Access Control)
        transform: {
          bucket: whatsNewDistributionBucketName
            ? (args, opts) => {
                args.bucket = whatsNewDistributionBucketName;
                args.forceDestroy = undefined;
              }
            : undefined,
        },
      },
      {
        retainOnDelete: whatsNewDistributionBucketName ? true : false,
      }
    )
  : undefined;

// CloudFront routing for public access (only if bucket exists)
if (router && whatsNewDistributionBucket) {
  router.routeBucket(`${routePrefix}/whats-new`, whatsNewDistributionBucket, {
    rewrite: {
      regex: `^${routePrefix}/whats-new/(.*)$`,
      to: '/$1',
    },
  });
}

// Lifecycle policy to clean up old versions after 90 days (only if bucket exists)
const whatsNewDistributionBucketLifecycle = whatsNewDistributionBucket
  ? new aws.s3.BucketLifecycleConfigurationV2('whatsNewDistributionBucketLifecycle', {
      bucket: whatsNewDistributionBucket.name,
      rules: [
        {
          id: 'expire-old-versions',
          status: 'Enabled',
          noncurrentVersionExpiration: {
            noncurrentDays: 90, // Keep 90 days of version history, then expire
          },
        },
        {
          id: 'cleanup-incomplete-uploads',
          status: 'Enabled',
          abortIncompleteMultipartUpload: {
            daysAfterInitiation: 1,
          },
        },
      ],
    })
  : undefined;

/**
 * ===============================
 * PublishedArtifactsBucket
 * ===============================
 * Hosts published artifact bundles (HTML/CSS/JS/images). Deliberately NOT routed
 * through CloudFront: every view goes through the gated `/api/publish/serve`
 * handler so visibility is enforced on the HTML AND every asset. The bucket is
 * private — written via presigned PUT (CORS allows PUT from the app origin) and
 * read by the Lambda IAM role. Drafts auto-expire after 1 day.
 */
const publishedArtifactsBucket = new sst.aws.Bucket(
  'publishedArtifactsBucket',
  {
    versioning: process.env.ENABLE_BUCKET_VERSIONING === 'true',
    cors: {
      allowOrigins: getAllowedOrigins(domain),
      allowHeaders: ['*'],
      allowMethods: ['GET', 'PUT', 'POST'],
    },
    transform: {
      bucket: publishedArtifactsBucketName
        ? (args, opts) => {
            args.bucket = publishedArtifactsBucketName;
            args.forceDestroy = undefined;
          }
        : undefined,
    },
  },
  {
    retainOnDelete: publishedArtifactsBucketName ? true : false,
  }
);

// Expire stalled drafts (uploaded but never finalized) after 1 day.
const publishedArtifactsBucketLifecycle = new aws.s3.BucketLifecycleConfigurationV2(
  'publishedArtifactsBucketLifecycle',
  {
    bucket: publishedArtifactsBucket.name,
    rules: [
      {
        id: 'expire-drafts',
        status: 'Enabled',
        filter: { prefix: 'drafts/' },
        expiration: { days: 1 },
        abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
      },
    ],
  }
);

export {
  fabFileBucket,
  generatedImagesBucket,
  appFilesBucket,
  publishedArtifactsBucket,
  publishedArtifactsBucketLifecycle,
  historyImportBucket,
  appFilesBucketNotification,
  historyImportBucketNotification,
  historyImportBucketLifecycle,
  appFilesBucketLifecycle,
  uploadCompleteFunction,
  notebookImportFunction,
  slackExportBucket,
  slackExportBucketLifecycle,
  whatsNewDistributionBucket,
  whatsNewDistributionBucketLifecycle,
};
