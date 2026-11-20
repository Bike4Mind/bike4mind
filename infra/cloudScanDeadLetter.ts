import { createEventBusDeadLetter } from './eventBusDeadLetter';

const cloudSecurityScanDlq = new sst.aws.Queue('cloudSecurityScanDlq', {
  transform: { queue: { messageRetentionSeconds: 1209600 } },
});

export const cloudSecurityScanDeadLetter = createEventBusDeadLetter('CloudSecurityScan', cloudSecurityScanDlq);
