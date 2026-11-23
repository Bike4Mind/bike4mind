import type { AdminAiAttempt } from '@bike4mind/common';
import { AdminAiAttemptModel } from '@bike4mind/database';

export const recordAdminAiAttempt = async (attempt: AdminAiAttempt): Promise<void> => {
  await AdminAiAttemptModel.create(attempt);
};
