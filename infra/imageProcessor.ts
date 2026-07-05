import { appFilesBucket, fabFileBucket, generatedImagesBucket } from './buckets';
import { allSecrets } from './secrets';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { lambdaVpc } from './vpc';

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
 */
export const imageProcessor = new sst.aws.Function('ImageProcessor', {
  vpc: lambdaVpc,
  handler: 'apps/client/server/utils/imageProcessor.handler',
  runtime: 'nodejs24.x',
  timeout: '5 minutes',
  memory: '2048 MB',
  link: [...allSecrets, generatedImagesBucket, appFilesBucket, fabFileBucket],
  logging: {
    retention: '3 days',
  },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
  },
});
