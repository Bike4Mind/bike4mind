import { appFilesBucket, fabFileBucket, generatedImagesBucket } from './buckets';
import { allSecrets } from './secrets';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';

/**
 * Image Processor Lambda Function
 *
 * This function handles image processing (PNG conversion and resizing) using jimp.
 * Jimp is pure JavaScript with no native dependencies, making it reliable in Lambda.
 *
 * Timeout: 5 minutes - jimp can be slow for large images
 * Memory: 2048 MB - more memory = faster jimp processing
 * Invocation: Direct Lambda SDK invocation from services that need image processing
 *
 * Note: Linked to S3 buckets to allow downloading images from S3 for processing
 *
 * No VPC: the handler takes the image in the invoke payload and returns it the same way, so it
 * opens no database or in-VPC connection. A handler change that adds one must restore `vpc`;
 * see docs/architecture/lambda-vpc-audit.md and infra/__tests__/lambdaVpcAudit.test.ts.
 */
export const imageProcessor = new sst.aws.Function('ImageProcessor', {
  handler: 'apps/workers/src/media/imageProcessor.handler',
  runtime: 'nodejs24.x',
  timeout: '5 minutes',
  memory: '2048 MB',
  link: [...allSecrets, generatedImagesBucket, appFilesBucket, fabFileBucket],
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});
