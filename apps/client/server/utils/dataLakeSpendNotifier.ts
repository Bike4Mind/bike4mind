import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  dataLakeSpendNotificationRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import mailer from './mailer';

/**
 * Assembles the real db/mailer ports for `enforceEmbeddingSpendGate`'s `notify` port
 * (#1677). Lives in apps/client because the gate itself (b4m-core/services) cannot import
 * @bike4mind/database or this app's mailer - this is the one place those come together.
 */
export const makeDataLakeSpendNotifier =
  (logger?: Logger) =>
  (event: dataLakeService.DataLakeSpendNotificationEvent): Promise<unknown> =>
    dataLakeService.sendDataLakeSpendNotification(event, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        organizations: organizationRepository,
        users: userRepository,
        spendNotifications: dataLakeSpendNotificationRepository,
      },
      mailer,
      logger,
    });
