import { dispatch } from '@workers/queueHandlers/accountDataExport';
import { registerRedrivenQueue } from './registerRedrivenQueue';
import type { SelfHostWorker } from './selfHostWorker';

export async function registerAccountDataExportQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrl: string | undefined,
  logger: { warn: (message: string) => void; error: (message: string, error: unknown) => void }
): Promise<void> {
  await registerRedrivenQueue(
    worker,
    {
      name: 'accountDataExportQueue',
      label: 'Account data export',
      queueUrl,
      deadLetterQueueUrl: process.env.ACCOUNT_DATA_EXPORT_QUEUE_DLQ,
      dispatch,
    },
    logger
  );
}
