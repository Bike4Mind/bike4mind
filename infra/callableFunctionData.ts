import { getAllowedOrigins } from './allowedOrigins';
import { BLOCK_ALL_PUBLIC_ACCESS } from './bucketSecurity';
import {
  FUNCTION_DATA_DISPATCHER_ACTIONS,
  FUNCTION_DATA_ERASER_ACTIONS,
  FUNCTION_DATA_KEY_PREFIX,
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

/** The web API function's bucket variable and object grant; neither on a stage without function data. */
export const callableFunctionDataForWeb: DataGrant = callableFunctionDataBucket
  ? {
      environment: { CALLABLE_FUNCTION_DATA_BUCKET: callableFunctionDataBucket.bucket },
      permissions: [
        {
          actions: FUNCTION_DATA_DISPATCHER_ACTIONS,
          resources: [$interpolate`${callableFunctionDataBucket.arn}/${FUNCTION_DATA_KEY_PREFIX}*`],
        },
        listDataKeys(callableFunctionDataBucket),
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
