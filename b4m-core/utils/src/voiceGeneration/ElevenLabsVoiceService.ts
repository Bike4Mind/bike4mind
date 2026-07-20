import axios from 'axios';
import { VoiceOutputFormat } from '@bike4mind/common';
import { AIVoiceService, CONTENT_TYPE_BY_FORMAT, VoiceSynthesisOptions, VoiceSynthesisResult } from './AIVoiceService';

const BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech/';
const DEFAULT_FORMAT: VoiceOutputFormat = 'mp3';

// ElevenLabs takes an `output_format` enum rather than a bare extension. Only
// the formats it actually supports are mapped; unsupported ones fail loudly
// instead of silently returning mislabeled bytes.
const ELEVENLABS_OUTPUT_FORMAT: Partial<Record<VoiceOutputFormat, string>> = {
  mp3: 'mp3_44100_128',
  pcm: 'pcm_44100',
  opus: 'opus_48000_128',
};

export class ElevenLabsVoiceService extends AIVoiceService {
  async synthesize(text: string, options: VoiceSynthesisOptions = {}): Promise<VoiceSynthesisResult> {
    const voiceId = options.voice;
    if (!voiceId) {
      throw new Error('ElevenLabs TTS requires a voice id');
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
    return { audio, contentType: CONTENT_TYPE_BY_FORMAT[format], format };
  }
}
