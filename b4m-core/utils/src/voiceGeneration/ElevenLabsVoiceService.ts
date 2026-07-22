import axios from 'axios';
import { VoiceOutputFormat, TTS_MAX_INPUT_CHARS } from '@bike4mind/common';
import { AIVoiceService, CONTENT_TYPE_BY_FORMAT, VoiceSynthesisOptions, VoiceSynthesisResult } from './AIVoiceService';

const BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech/';
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
const DEFAULT_BILLING_MODEL = 'eleven_multilingual_v2';

// ElevenLabs takes an `output_format` enum rather than a bare extension. Only
// the formats it actually supports are mapped; unsupported ones fail loudly
// instead of silently returning mislabeled bytes. The key set here MUST stay in
// sync with VOICE_VENDOR_SUPPORTED_FORMATS.elevenlabs (@bike4mind/common), which
// the /api/ai/tts route uses to reject an unsupported format before this point.
const ELEVENLABS_OUTPUT_FORMAT: Partial<Record<VoiceOutputFormat, string>> = {
  mp3: 'mp3_44100_128',
  pcm: 'pcm_44100',
  opus: 'opus_48000_128',
};

export class ElevenLabsVoiceService extends AIVoiceService {
  async synthesize(text: string, options: VoiceSynthesisOptions = {}): Promise<VoiceSynthesisResult> {
    if (text.length > MAX_INPUT_CHARS) {
      throw new Error(`ElevenLabs TTS input exceeds ${MAX_INPUT_CHARS} characters (got ${text.length})`);
    }

    const voiceId = options.voice ?? DEFAULT_VOICE;
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
    if (options.stability !== undefined || options.similarityBoost !== undefined) {
      body.voice_settings = {
        stability: options.stability ?? 0,
        similarity_boost: options.similarityBoost ?? 0,
      };
    }

    const response = await axios.post(`${BASE_URL}${voiceId}`, body, {
      headers: { 'Content-Type': 'application/json', 'xi-api-key': this.apiKey },
      params: { output_format: outputFormat },
      responseType: 'arraybuffer',
    });

    const audio = Buffer.from(response.data, 'binary');
    return {
      audio,
      contentType: CONTENT_TYPE_BY_FORMAT[format],
      format,
      model: options.model ?? DEFAULT_BILLING_MODEL,
      characters: text.length,
    };
  }
}
