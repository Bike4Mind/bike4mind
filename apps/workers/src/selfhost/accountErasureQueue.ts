import { dispatch } from '@workers/queueHandlers/accountErasure';
import { registerRedrivenQueue } from './registerRedrivenQueue';
import type { SelfHostWorker } from './selfHostWorker';

export async function registerAccountErasureQueue(
  worker: Pick<SelfHostWorker, 'registerQueueHandler'>,
  queueUrl: string | undefined,
  logger: { warn: (message: string) => void; error: (message: string, error: unknown) => void }
): Promise<void> {
  await registerRedrivenQueue(
    worker,
    {
      name: 'accountErasureQueue',
      label: 'Account erasure',
      queueUrl,
      deadLetterQueueUrl: process.env.ACCOUNT_ERASURE_QUEUE_DLQ,
      dispatch,
    },
    logger
  );
}
