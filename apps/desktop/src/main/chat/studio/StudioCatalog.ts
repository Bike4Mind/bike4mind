import { z } from 'zod';
import { IMAGE_MODEL_CATALOG, type ImageModels } from '@bike4mind/common';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { StudioCatalog } from '@shared/studioIpc';
import type { ModelCatalog } from '../ModelCatalog';
import { MediaApiClient } from '../media/MediaApiClient';

export async function readStudioCatalog(api: AuthenticatedApiClient, models: ModelCatalog): Promise<StudioCatalog> {
  const [images, videos, music, audio, voices] = await Promise.all([
    api.get<unknown>('/api/v1/image-models'),
    models.listVideoModels(),
    new MediaApiClient(api).listMusicModels(),
    api.get<unknown>('/api/ai/audio-providers'),
    api.get<unknown>('/api/ai/elevenlabs-voices').catch(() => ({ voices: [] })),
  ]);
  const imageList = z
    .object({
      models: z.array(z.object({ id: z.string(), name: z.string().optional(), display_name: z.string().optional() })),
    })
    .parse(images);
  const providers = z
    .object({ speech: z.array(z.enum(['openai', 'elevenlabs'])), soundEffects: z.array(z.literal('elevenlabs')) })
    .parse(audio);
  const voiceList = z.object({ voices: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(voices);
  return {
    // Images submit to /api/v1/image-jobs, which has no Studio feature gate: the model list is the whole answer.
    images: imageList.models.flatMap(model =>
      Object.hasOwn(IMAGE_MODEL_CATALOG, model.id)
        ? [
            {
              id: model.id,
              name: model.name ?? model.display_name ?? model.id,
              capabilities: IMAGE_MODEL_CATALOG[model.id as ImageModels],
            },
          ]
        : []
    ),
    videos,
    music,
    ...providers,
    voices: voiceList.voices,
  };
}
