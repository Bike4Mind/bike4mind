import { z } from 'zod';
import { MusicGenerationRequestSchema, type PublicMusicModel } from '@bike4mind/common';
import {
  readStoredField,
  type Restored,
  type StudioRestoreRequest,
} from '@client/app/components/Studio/restore/studioRestore';
import type { NonEmptyList } from '@client/app/components/Studio/useCapabilityFormState';
import { initialFormFor, type MusicFormState } from './musicForm';

const shape = MusicGenerationRequestSchema.shape;
const MS_PER_SECOND = 1000;

function restoreModel(stored: unknown, models: NonEmptyList<PublicMusicModel>, notices: string[]): PublicMusicModel {
  const model = models.find(candidate => candidate.id === stored);
  if (model) return model;
  const fallback = models[0];
  notices.push(
    typeof stored === 'string'
      ? `${stored} is no longer one of your music models, so ${fallback.display_name} is picked.`
      : `The take did not record its model, so ${fallback.display_name} is picked.`
  );
  return fallback;
}

/**
 * The music form for a stored music request. Songs made before music ran as jobs stored the legacy route's shape
 * (`modelId`, `lengthMs`, `forceInstrumental`), read here as the same settings.
 */
export function restoreMusicForm(
  { request }: StudioRestoreRequest,
  models: NonEmptyList<PublicMusicModel>
): Restored<MusicFormState> {
  const notices: string[] = [];
  const model = restoreModel(request.model ?? request.modelId, models, notices);
  const base = initialFormFor(model);
  const legacySeconds = typeof request.lengthMs === 'number' ? Math.round(request.lengthMs / MS_PER_SECOND) : undefined;
  const durationSeconds = readStoredField(
    shape.durationSeconds,
    request.durationSeconds ?? legacySeconds,
    base.durationSeconds ?? undefined,
    'duration',
    notices
  );
  const value: MusicFormState = {
    ...base,
    prompt: readStoredField(shape.prompt, request.prompt, base.prompt, 'prompt', notices),
    lyrics: readStoredField(z.string(), request.lyrics, base.lyrics, 'lyrics', notices),
    instrumental: readStoredField(
      z.boolean(),
      request.instrumental ?? request.forceInstrumental,
      base.instrumental,
      'instrumental setting',
      notices
    ),
    // A fixed-length model takes no duration; out-of-range values stay for the form to mark.
    durationSeconds: base.durationSeconds === null ? null : (durationSeconds ?? base.durationSeconds),
  };
  return { value, notices };
}
