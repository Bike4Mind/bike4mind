import { dispatch } from '@server/queueHandlers/questExport';
import { registerRedrivenQueue } from './registerRedrivenQueue';
import type { SelfHostWorker } from './selfHostWorker';

export async function registerQuestExportQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrl: string | undefined,
  logger: { warn: (message: string) => void; error: (message: string, error: unknown) => void }
): Promise<void> {
  await registerRedrivenQueue(
    worker,
    {
      name: 'questExportQueue',
      label: 'Quest export',
      queueUrl,
      deadLetterQueueUrl: process.env.QUEST_EXPORT_QUEUE_DLQ,
      dispatch,
    },
    logger
  );
}
