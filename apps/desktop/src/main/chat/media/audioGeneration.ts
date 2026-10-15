import type { MusicRequest, SoundEffectsRequest, TTSRequest } from '@bike4mind/common';
import type { ChatMedia, ChatToolNotice } from '@shared/chat';
import type { GeneratedAudio, MediaApiClient } from './MediaApiClient';
import type { MediaStore } from './MediaStore';

/**
 * The Audio tag of the b4m API: synthesizeSpeech, generateSoundEffect and generateMusic.
 *
 * All three are credit-metered, all three can save a browsable copy to the file browser, and
 * all three land here as bytes on disk plus a ChatMedia the renderer can play. They differ only
 * in how the bytes arrive (JSON base64 for speech, a raw body for the other two), which is the
 * client's problem rather than this module's.
 */

export interface AudioOutcome {
  media: ChatMedia;
  /** Set when a provider other than the requested one produced the audio. */
  notice?: ChatToolNotice;
  /** The browsable copy the server kept, when it kept one. */
  fabFileId?: string;
}

export interface AudioDeps {
  client: MediaApiClient;
  store: MediaStore;
  /** Local conversation id, which is the media folder these bytes land in. */
  sessionId: string;
}

/**
 * Synthesize speech from text.
 *
 * The provider substitution is lifted out of the response into a notice: the endpoint quietly
 * stands another vendor in when the requested one has no usable key, which means a different
 * voice than the one asked for. Leaving that in the tool's result text would leave the user
 * wondering why what they hear does not match what they chose.
 */
export async function synthesizeSpeech(request: Omit<TTSRequest, 'encoding'>, deps: AudioDeps): Promise<AudioOutcome> {
  const response = await deps.client.synthesizeSpeech(request);
  // Audio over the server's response ceiling comes back as a signed storage URL instead of inline.
  const audio =
    response.delivery === 'url'
      ? (await deps.client.fetchGenerated(response.url)).bytes
      : Buffer.from(response.audio, 'base64');
  const stored = await deps.store.save(deps.sessionId, audio, response.contentType);

  const substituted = !!response.fallbackFrom && !!response.provider && response.fallbackFrom !== response.provider;

  return {
    media: {
      kind: 'audio',
      url: stored.url,
      mimeType: stored.mimeType,
      byteLength: stored.byteLength,
      caption: request.text,
      ...(response.fabFileId ? { fabFileId: response.fabFileId } : {}),
    },
    ...(substituted
      ? {
          notice: {
            kind: 'provider-substituted' as const,
            text:
              `${response.fallbackFrom} has no usable key on this server, so ${response.provider} generated ` +
              'this instead. The voice will not be the one that was asked for.',
          },
        }
      : {}),
    ...(response.fabFileId ? { fabFileId: response.fabFileId } : {}),
  };
}

export async function generateSoundEffect(request: SoundEffectsRequest, deps: AudioDeps): Promise<AudioOutcome> {
  return storeAudio(await deps.client.generateSoundEffect(request), request.text, deps);
}

export async function generateMusic(request: MusicRequest, deps: AudioDeps): Promise<AudioOutcome> {
  return storeAudio(await deps.client.generateMusic(request), request.prompt, deps);
}

async function storeAudio(generated: GeneratedAudio, caption: string, deps: AudioDeps): Promise<AudioOutcome> {
  const stored = await deps.store.save(deps.sessionId, generated.audio, generated.contentType);
  return {
    media: {
      kind: 'audio',
      url: stored.url,
      mimeType: stored.mimeType,
      byteLength: stored.byteLength,
      caption,
      ...(generated.fabFileId ? { fabFileId: generated.fabFileId } : {}),
    },
    ...(generated.fabFileId ? { fabFileId: generated.fabFileId } : {}),
  };
}
