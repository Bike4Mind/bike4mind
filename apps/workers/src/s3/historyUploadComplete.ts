// Lambda entry for HistoryUploadCompleteFunction (infra/buckets.ts). The self-host MinIO webhook
// (apps/client/pages/api/internal/s3/object-created.ts) runs the same module in-process.
export * from '@bike4mind/server-utils/s3/historyUploadComplete';
