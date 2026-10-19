import {
  LIVEOPS_TRIAGE_CONFIG_AUDIT_LOG_RETENTION_SECONDS,
  LiveopsTriageConfigAuditLogModel,
} from '@bike4mind/database';
import { setTtlIndexRetention } from '../setTtlIndexRetention';
import { type MigrationFile } from './index';

/** Raise the liveops triage config audit log TTL on timestamp to 12 months; see setTtlIndexRetention for why this needs collMod. */
const migration: MigrationFile = {
  id: 20260921235953,
  name: 'set liveops triage config audit log retention to 12 months',

  up: async () => {
    await setTtlIndexRetention(
      LiveopsTriageConfigAuditLogModel,
      { timestamp: 1 },
      LIVEOPS_TRIAGE_CONFIG_AUDIT_LOG_RETENTION_SECONDS
    );
  },

  down: async () => {
    // One-way. Shortening the TTL would immediately delete up to nine months of audit history.
  },
};

export default migration;
