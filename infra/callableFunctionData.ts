import { getAllowedOrigins } from './allowedOrigins';
import { BLOCK_ALL_PUBLIC_ACCESS } from './bucketSecurity';
import {
  FUNCTION_DATA_DISPATCHER_ACTIONS,
  FUNCTION_DATA_ERASER_ACTIONS,
  FUNCTION_DATA_KEY_PREFIX,
  FUNCTION_LIVE_SOURCE_KEY_PREFIX,
  namedSubnetIdsOf,
} from './callableFunctionNetwork';
import { PRODUCTION_STAGES } from './constants';
import { domain } from './router';

// Data files for callable functions, keyed by callableFunctionDataKey (packages/server-utils). A raw bucket because
// sst.aws.Bucket resolves its name only after its own policy, which here names a role that needs that name first.
const retained = PRODUCTION_STAGES.includes($app.stage);

// A stage on named subnets has no endpoint of its own to read through, so it gets no function data at all.
const onNamedSubnets = namedSubnetIdsOf(process.env.CALLABLE_FUNCTION_SUBNET_IDS).length > 0;
if (onNamedSubnets) {
  console.warn(
    'Function data is not available on this stage: it names CALLABLE_FUNCTION_SUBNET_IDS, so it creates no function-data bucket.'
  );
}

export const callableFunctionDataBucket = onNamedSubnets
  ? undefined
  : new aws.s3.Bucket('CallableFunctionDataBucket', { forceDestroy: !retained }, { retainOnDelete: retained });

function secureDataBucket(bucket: aws.s3.Bucket) {
  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock('CallableFunctionDataPublicAccessBlock', {
    bucket: bucket.bucket,
    ...BLOCK_ALL_PUBLIC_ACCESS,
  });
  new aws.s3.BucketServerSideEncryptionConfiguration('CallableFunctionDataEncryption', {
    bucket: bucket.bucket,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
  });
  // The owner's browser fetches its pinned files from a signed link (linkCallableFunctionDataForBrowser).
  new aws.s3.BucketCorsConfiguration('CallableFunctionDataCors', {
    bucket: bucket.bucket,
    corsRules: [{ allowedOrigins: getAllowedOrigins(domain, $app.stage), allowedMethods: ['GET'], maxAgeSeconds: 600 }],
  });
  // Every call stores its live source fetches, and nothing reads one once that call's 5 minute links lapse.
  new aws.s3.BucketLifecycleConfigurationV2('CallableFunctionLiveSourceExpiry', {
    bucket: bucket.bucket,
    rules: [
      {
        id: 'expire-live-source-fetches',
        status: 'Enabled',
        filter: { prefix: FUNCTION_LIVE_SOURCE_KEY_PREFIX },
        expiration: { days: 1 },
        abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
      },
    ],
  });
  return publicAccessBlock;
}

export const callableFunctionDataPublicAccessBlock = callableFunctionDataBucket
  ? secureDataBucket(callableFunctionDataBucket)
  : undefined;

type DataGrant = {
  environment: Record<string, $util.Output<string>>;
  permissions: Array<{
    actions: string[];
    resources: $util.Output<string>[];
    conditions?: { test: string; variable: string; values: string[] }[];
  }>;
};

/** A key listing under `data/` only, which a delete by prefix needs. */
const listDataKeys = (bucket: aws.s3.Bucket) => ({
  actions: ['s3:ListBucket'],
  resources: [bucket.arn],
  conditions: [{ test: 'StringLike', variable: 's3:prefix', values: [`${FUNCTION_DATA_KEY_PREFIX}*`] }],
});

// Named, so the web API function can be granted the role before the role exists: its trust names that function's role
// (infra/callableFunctionDataPolicy.ts). `sst dev` has no server role to trust, so no browser role and the browser
// reads through the read route's bytes there.
export const callableFunctionDataBrowserReaderRoleName = `${$app.name}-${$app.stage}-fn-data-browser`;
const browserReaderRoleArn = $interpolate`arn:${aws.getPartitionOutput().partition}:iam::${aws.getCallerIdentityOutput().accountId}:role/${callableFunctionDataBrowserReaderRoleName}`;
const browserReaderForWeb: DataGrant = $dev
  ? { environment: {}, permissions: [] }
  : {
      environment: { CALLABLE_FUNCTION_DATA_BROWSER_ROLE_ARN: browserReaderRoleArn },
      permissions: [{ actions: ['sts:AssumeRole'], resources: [browserReaderRoleArn] }],
    };

/**
 * The web API function's bucket variable and object grant, and its grant to assume the browser-link reader role;
 * none on a stage without function data.
 */
export const callableFunctionDataForWeb: DataGrant = callableFunctionDataBucket
  ? {
      environment: {
        CALLABLE_FUNCTION_DATA_BUCKET: callableFunctionDataBucket.bucket,
        ...browserReaderForWeb.environment,
      },
      permissions: [
        {
          actions: FUNCTION_DATA_DISPATCHER_ACTIONS,
          resources: [$interpolate`${callableFunctionDataBucket.arn}/${FUNCTION_DATA_KEY_PREFIX}*`],
        },
        listDataKeys(callableFunctionDataBucket),
        ...browserReaderForWeb.permissions,
      ],
    }
  : { environment: {}, permissions: [] };

/** The account-erasure worker's: list and delete under `data/`, never read or write. */
export const callableFunctionDataForEraser: DataGrant = callableFunctionDataBucket
  ? {
      environment: { CALLABLE_FUNCTION_DATA_BUCKET: callableFunctionDataBucket.bucket },
      permissions: [
        {
          actions: FUNCTION_DATA_ERASER_ACTIONS,
          resources: [$interpolate`${callableFunctionDataBucket.arn}/${FUNCTION_DATA_KEY_PREFIX}*`],
        },
        listDataKeys(callableFunctionDataBucket),
      ],
    }
  : { environment: {}, permissions: [] };
