import type { GeneratedAudioResponse } from '@bike4mind/common';

export type PlayableAudio = {
  url: string;
  /** True when `url` is an object URL the caller must revoke; false for a signed storage URL. */
  isObjectUrl: boolean;
};

/**
 * Turns a generated-audio JSON body into something an <audio> element can play.
 * The url variant (audio too large to inline) is played straight from storage;
 * inline audio is decoded into a blob: URL. Not a data: URL: the app CSP allows
 * `media-src blob:` but not `data:`, so a data: source renders in the <audio>
 * element but is blocked from actually playing.
 */
export function toPlayableAudio(data: GeneratedAudioResponse): PlayableAudio {
  if (data.delivery === 'url') return { url: data.url, isObjectUrl: false };

  const bytes = Uint8Array.from(atob(data.audio), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: data.contentType }));
  return { url, isObjectUrl: true };
}
