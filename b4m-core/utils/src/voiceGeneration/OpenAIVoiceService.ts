import OpenAI from 'openai';
import { VoiceOutputFormat } from '@bike4mind/common';
import { AIVoiceService, CONTENT_TYPE_BY_FORMAT, VoiceSynthesisOptions, VoiceSynthesisResult } from './AIVoiceService';

const DEFAULT_MODEL = 'tts-1';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_FORMAT: VoiceOutputFormat = 'mp3';

export class OpenAIVoiceService extends AIVoiceService {
  async synthesize(text: string, options: VoiceSynthesisOptions = {}): Promise<VoiceSynthesisResult> {
    const format = options.format ?? DEFAULT_FORMAT;
    const openai = new OpenAI({ apiKey: this.apiKey });

    const response = await openai.audio.speech.create({
      model: options.model ?? DEFAULT_MODEL,
      // OpenAI ships a fixed set of voice names; the caller-supplied string is
      // validated by OpenAI (400 on an unknown voice) rather than by us, so the
      // supported set stays owned by the SDK.
      voice: (options.voice ?? DEFAULT_VOICE) as OpenAI.Audio.Speech.SpeechCreateParams['voice'],
      input: text,
      response_format: format,
    });

    const audio = Buffer.from(await response.arrayBuffer());
    return { audio, contentType: CONTENT_TYPE_BY_FORMAT[format], format };
  }
}
