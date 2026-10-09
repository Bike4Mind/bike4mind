import { dispatch } from '@workers/queueHandlers/notebookCuration';
import { registerRedrivenQueue } from './registerRedrivenQueue';
import type { SelfHostWorker } from './selfHostWorker';

export async function registerNotebookCurationQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrl: string | undefined,
  logger: { warn: (message: string) => void; error: (message: string, error: unknown) => void }
): Promise<void> {
  await registerRedrivenQueue(
    worker,
    {
      name: 'notebookCurationQueue',
      label: 'Notebook curation',
      queueUrl,
      deadLetterQueueUrl: process.env.NOTEBOOK_CURATION_QUEUE_DLQ,
      dispatch,
    },
    logger
  );
}
