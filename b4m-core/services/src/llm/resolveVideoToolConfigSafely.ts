import type { Logger } from '@bike4mind/observability';
import type { VideoToolConfig } from './tools/implementation/videoGeneration';

export async function resolveVideoToolConfigSafely(
  resolve: (() => Promise<VideoToolConfig | null>) | undefined,
  logger: Logger
): Promise<VideoToolConfig | null> {
  if (!resolve) return null;
  try {
    return await resolve();
  } catch (error) {
    logger.warn('video_generation unavailable: capability resolution failed', error);
    return null;
  }
}
