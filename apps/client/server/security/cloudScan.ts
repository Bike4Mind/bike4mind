// Lambda entry for the CloudSecurityScan cron (infra/cron.ts). It stays in apps/client so SST
// bundles it against apps/client's package.json, as before the move.
export * from '@bike4mind/server-utils/security/cloudScan';
