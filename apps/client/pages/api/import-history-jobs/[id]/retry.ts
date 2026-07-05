import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { importHistoryJobRepository } from '@bike4mind/database';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';
import { S3Storage } from '@bike4mind/fab-pipeline';

const handler = baseApi({ auth: true }).post(
  asyncHandler(async (req, res) => {
    const { id } = req.query as any;
    const userId = req.user.id;

    const importJob = await importHistoryJobRepository.findByIdAndUserId(id, userId);

    if (!importJob) {
      return res.status(404).json({
        success: false,
        message: 'Import job not found',
      });
    }

    if (importJob.status !== 'failed') {
      return res.status(400).json({
        success: false,
        message: 'Can only retry failed imports',
      });
    }

    const s3 = new S3Storage(importJob.s3Bucket);
    try {
      await s3.getMetadata(importJob.s3Key);
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
        return res.status(404).json({
          success: false,
          message: 'Import file no longer exists in S3. Please upload again.',
        });
      }
      throw err;
    }

    await importHistoryJobRepository.update({
      id,
      status: 'pending',
      progress: 0,
      currentStep: 'Retrying import...',
      errorMessage: undefined,
      errorStack: undefined,
      failedAt: undefined,
      processedItems: 0,
      failedItems: 0,
    });

    const lambdaClient = new LambdaClient({});

    // Create a synthetic S3 event to trigger the import
    const s3Event = {
      Records: [
        {
          s3: {
            bucket: {
              name: importJob.s3Bucket,
            },
            object: {
              key: importJob.s3Key,
            },
          },
        },
      ],
    };

    const functionName =
      importJob.source === 'Notebook'
        ? Resource.NotebookImportCompleteFunction.name
        : Resource.HistoryUploadCompleteFunction.name;

    try {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: 'Event', // Async invocation
          Payload: Buffer.from(JSON.stringify(s3Event)),
        })
      );

      return res.json({
        success: true,
        message: 'Import retry initiated',
        data: { id: importJob.id },
      });
    } catch (error) {
      console.error('Failed to invoke Lambda for retry:', error);

      await importHistoryJobRepository.update({
        id,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Failed to initiate retry',
      });

      return res.status(500).json({
        success: false,
        message: 'Failed to initiate retry',
      });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
