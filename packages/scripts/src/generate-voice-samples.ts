/**
 * Regenerates the pre-recorded OpenAI voice samples Studio plays, one mp3 per AVAILABLE_TTS_VOICES
 * entry, with the model real synthesis uses so a sample sounds like the output.
 *
 *   OPENAI_API_KEY=... pnpm --filter @bike4mind/scripts voice-samples:generate
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AVAILABLE_TTS_VOICES, openAiVoiceSamplePath, TTS_VOICE_SAMPLE_TEXT } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { aiVoiceService } from '@bike4mind/utils';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '../../../apps/client/public');

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');

  const service = aiVoiceService('openai', apiKey, new Logger());
  for (const { value: voice } of AVAILABLE_TTS_VOICES) {
    const result = await service.synthesize(TTS_VOICE_SAMPLE_TEXT, { voice, format: 'mp3' });
    const file = path.join(PUBLIC_DIR, openAiVoiceSamplePath(voice));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, result.audio);
    console.log(`${voice}: ${result.model}, ${result.audio.length} bytes -> ${path.relative(process.cwd(), file)}`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
