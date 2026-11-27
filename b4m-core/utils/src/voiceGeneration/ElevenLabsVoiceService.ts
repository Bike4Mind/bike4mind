import axios from 'axios';
import { z } from 'zod';
import { VoiceOutputFormat, TTS_DEFAULT_MODEL, TTS_MAX_INPUT_CHARS } from '@bike4mind/common';
import { AIVoiceService, CONTENT_TYPE_BY_FORMAT, VoiceSynthesisOptions, VoiceSynthesisResult } from './AIVoiceService';
import { CharacterAlignmentSchema, wordTimingsFromCharacterAlignment } from './speechAlignment';

const BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech/';
const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Error-shaped bodies only; an allow-list would risk refusing a format whose audio type we have not seen.
const NON_AUDIO_CONTENT_TYPE = /^text\/|json|xml|html/;
const DEFAULT_FORMAT: VoiceOutputFormat = 'mp3';
const MAX_INPUT_CHARS = TTS_MAX_INPUT_CHARS.elevenlabs;
// ElevenLabs premade "Rachel" voice - available on every account, used when the
// caller supplies no voice and the user has no active voice (parallels OpenAI's
// 'alloy' default).
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';
// When the caller sends no model_id, ElevenLabs applies its server-side default
// (multilingual v2). We don't send model_id in that case (preserving behavior),
// but we must bill *something*, so we attribute the call to this model. It is
// also the higher-priced tier, so an unspecified model bills conservatively.
const DEFAULT_BILLING_MODEL = TTS_DEFAULT_MODEL.elevenlabs;

// ElevenLabs takes an `output_format` enum rather than a bare extension. Only
// the formats it actually supports are mapped; unsupported ones fail loudly
// instead of silently returning mislabeled bytes. The key set here MUST stay in
// sync with VOICE_VENDOR_SUPPORTED_FORMATS.elevenlabs (@bike4mind/common), which
// the /api/ai/tts route uses to reject an unsupported format before this point.
export const ELEVENLABS_OUTPUT_FORMAT: Partial<Record<VoiceOutputFormat, string>> = {
  mp3: 'mp3_44100_128',
  pcm: 'pcm_44100',
  opus: 'opus_48000_128',
};

// The /with-timestamps variant answers JSON: the audio as base64 plus the alignment of the text as sent. The
// alignment is checked on its own so a malformed one costs only the timings, not the audio.
const TimestampedSpeechSchema = z.object({
  audio_base64: z.string().min(1),
  alignment: z.unknown(),
});

export class ElevenLabsVoiceService extends AIVoiceService {
  async synthesize(text: string, options: VoiceSynthesisOptions = {}): Promise<VoiceSynthesisResult> {
    if (text.length > MAX_INPUT_CHARS) {
      throw new Error(`ElevenLabs TTS input exceeds ${MAX_INPUT_CHARS} characters (got ${text.length})`);
    }

    const voiceId = options.voice ?? DEFAULT_VOICE;
    // The id is interpolated into the request path, so a caller-supplied `/` or `..` would retarget
    // the call to another endpoint on the account's key. Tagged 422 so the API reports it as a
    // rejected request (the caller's input) rather than an upstream outage.
    if (!VOICE_ID_PATTERN.test(voiceId)) {
      throw Object.assign(new Error(`Invalid ElevenLabs voice id: ${JSON.stringify(voiceId.slice(0, 64))}`), {
        status: 422,
      });
    }
    const format = options.format ?? DEFAULT_FORMAT;
    const outputFormat = ELEVENLABS_OUTPUT_FORMAT[format];
    if (!outputFormat) {
      throw new Error(
        `ElevenLabs does not support the '${format}' output format (supported: ${Object.keys(
          ELEVENLABS_OUTPUT_FORMAT
        ).join(', ')})`
      );
    }

    const body: Record<string, unknown> = { text };
    if (options.model) {
      body.model_id = options.model;
    }
    // Pins the output language on v2.5+/v3 models; older models ignore it.
    if (options.language) {
      body.language_code = options.language;
    }
    if (options.stability !== undefined || options.similarityBoost !== undefined) {
      // Send only the field the caller actually set. Omitting the other lets
      // ElevenLabs apply that voice's own default (~0.75) instead of forcing it
      // to 0, which would silently degrade output on a one-field request.
      body.voice_settings = {
        ...(options.stability !== undefined && { stability: options.stability }),
        ...(options.similarityBoost !== undefined && { similarity_boost: options.similarityBoost }),
      };
    }

    const request = { voiceId, body, outputFormat, signal: options.signal };
    const { audio, wordTimings } = options.withTimestamps
      ? await this.synthesizeWithTimestamps(request)
      : { audio: await this.synthesizeAudio(request), wordTimings: undefined };
    return {
      audio,
      contentType: CONTENT_TYPE_BY_FORMAT[format],
      format,
      model: options.model ?? DEFAULT_BILLING_MODEL,
      characters: text.length,
      ...(wordTimings && { wordTimings }),
    };
  }

  private async synthesizeAudio({ voiceId, body, outputFormat, signal }: ElevenLabsSpeechRequest): Promise<Buffer> {
    const response = await axios.post(`${BASE_URL}${voiceId}`, body, {
      headers: { 'Content-Type': 'application/json', 'xi-api-key': this.apiKey },
      params: { output_format: outputFormat },
      responseType: 'arraybuffer',
      signal,
    });

    // Checked before returning, since callers bill on a successful result.
    const responseType = String(response.headers?.['content-type'] ?? '').toLowerCase();
    if (NON_AUDIO_CONTENT_TYPE.test(responseType)) {
      throw new Error(`ElevenLabs returned non-audio content (${responseType})`);
    }
    return Buffer.from(response.data, 'binary');
  }

  /** Same audio, plus word timings. A missing or malformed alignment loses only the timings, never the clip. */
  private async synthesizeWithTimestamps({ voiceId, body, outputFormat, signal }: ElevenLabsSpeechRequest) {
    const response = await axios.post(`${BASE_URL}${voiceId}/with-timestamps`, body, {
      headers: { 'Content-Type': 'application/json', 'xi-api-key': this.apiKey },
      params: { output_format: outputFormat },
      responseType: 'json',
      signal,
    });
    const parsed = TimestampedSpeechSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error('ElevenLabs returned an unexpected with-timestamps response');
    }
    const audio = Buffer.from(parsed.data.audio_base64, 'base64');
    if (audio.length === 0) throw new Error('ElevenLabs returned empty audio');
    const alignment = CharacterAlignmentSchema.safeParse(parsed.data.alignment);
    const wordTimings = alignment.success ? wordTimingsFromCharacterAlignment(alignment.data) : undefined;
    if (!wordTimings) {
      this.logger.warn('elevenlabs_speech_alignment_unusable', {
        voiceId,
        hasAlignment: parsed.data.alignment != null,
        malformed: parsed.data.alignment != null && !alignment.success,
      });
    }
    return { audio, wordTimings };
  }
}

type ElevenLabsSpeechRequest = {
  voiceId: string;
  body: Record<string, unknown>;
  outputFormat: string;
  signal?: AbortSignal;
};
