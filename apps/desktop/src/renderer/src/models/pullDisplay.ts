import { formatBytes, type ModelPull } from '@shared/models';

export function pullPercent(pull: ModelPull): number {
  const total = Math.max(pull.totalBytes ?? 0, pull.expectedBytes);
  return total > 0 ? Math.min(100, (pull.completedBytes / total) * 100) : 0;
}

export function pullLabel(pull: ModelPull): string {
  if (pull.phase === 'verifying') return 'Checking the file on Hugging Face';
  if (pull.phase === 'finishing') return 'Verifying and finishing';
  if (pull.phase === 'failed') return pull.error?.message ?? 'Download failed.';
  const total = Math.max(pull.totalBytes ?? 0, pull.expectedBytes);
  const progress = `${formatBytes(pull.completedBytes)} of ${formatBytes(total)} (${Math.floor(pullPercent(pull))}%)`;
  return pull.phase === 'paused' ? `Paused at ${progress}` : progress;
}
