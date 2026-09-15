import { Resource } from 'sst';

export function resolveStage(): string {
  try {
    const stage =
      Resource.App.stage || process.env.SST_STAGE || process.env.NODE_ENV || process.env.SEED_STAGE_NAME || 'unknown';
    return String(stage);
  } catch {
    return process.env.SST_STAGE || process.env.NODE_ENV || process.env.SEED_STAGE_NAME || 'unknown';
  }
}
