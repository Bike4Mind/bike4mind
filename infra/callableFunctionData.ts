import { BLOCK_ALL_PUBLIC_ACCESS } from './bucketSecurity';
import {
  FUNCTION_DATA_DISPATCHER_ACTIONS,
  FUNCTION_DATA_KEY_PREFIX,
  namedSubnetIdsOf,
} from './callableFunctionNetwork';
import { PRODUCTION_STAGES } from './constants';

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

function createDataBucket() {
  const bucket = new aws.s3.Bucket(
    'CallableFunctionDataBucket',
    { forceDestroy: !retained },
    { retainOnDelete: retained }
  );
  const publicAccessBlock = new aws.s3.BucketPublicAccessBlock('CallableFunctionDataPublicAccessBlock', {
    bucket: bucket.bucket,
    ...BLOCK_ALL_PUBLIC_ACCESS,
  });
  new aws.s3.BucketServerSideEncryptionConfiguration('CallableFunctionDataEncryption', {
    bucket: bucket.bucket,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
  });
  return { bucket, publicAccessBlock };
}

const data = onNamedSubnets ? undefined : createDataBucket();

export const callableFunctionDataBucket = data?.bucket;
export const callableFunctionDataPublicAccessBlock = data?.publicAccessBlock;

/** The web API function's bucket variable and object grant; neither on a stage without function data. */
export const callableFunctionDataForWeb: {
  environment: Record<string, $util.Output<string>>;
  permissions: Array<{ actions: string[]; resources: $util.Output<string>[] }>;
} = data
  ? {
      environment: { CALLABLE_FUNCTION_DATA_BUCKET: data.bucket.bucket },
      permissions: [
        {
          actions: FUNCTION_DATA_DISPATCHER_ACTIONS,
          resources: [$interpolate`${data.bucket.arn}/${FUNCTION_DATA_KEY_PREFIX}*`],
        },
      ],
    }
  : { environment: {}, permissions: [] };
