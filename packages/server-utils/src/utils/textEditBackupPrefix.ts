/**
 * Key prefix for the pre-overwrite backup a text AI edit writes (apply-edit.ts). Nothing reads
 * these back; the lifecycle rules in infra/buckets.ts (`expire-text-edit-backups`),
 * compose.selfhost.yaml and selfhost/kubernetes/files/buckets.sh expire them and must stay in
 * sync with this value. Skipped by the object-created handlers (no FabFile row). A leaf module so
 * untrackedFabFileKey.ts stays free of storage imports.
 */
export const TEXT_EDIT_BACKUP_PREFIX = 'text-edit-backups/';
