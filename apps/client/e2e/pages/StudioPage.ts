import { expect, type Locator, type Response } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

/** Must stay in sync with STUDIO_MODALITIES in app/components/Studio/studioModality.ts (tab order). */
export const STUDIO_MODALITIES = ['video', 'music', 'speech', 'sound-effects'] as const;
export type StudioModality = (typeof STUDIO_MODALITIES)[number];

export type AudioMode = 'speech' | 'sound-effects';

/** POST /api/ai/tts or /api/ai/sound-effects (useGenerateAudio.ts). */
const AUDIO_ENDPOINT: Record<AudioMode, RegExp> = {
  speech: /\/api\/ai\/tts(?:\?|$)/,
  'sound-effects': /\/api\/ai\/sound-effects(?:\?|$)/,
};

/** Audio generation is a synchronous provider call plus a save to Files; allow for a cold provider. */
export const AUDIO_GENERATION_TIMEOUT = 90_000;

/**
 * Page object for Studio (`/studio/$modality`): the tab strip, each modality's form, and the
 * gallery of the user's generations with its media player.
 *
 * Test ids come from STUDIO_MODALITY_DEFINITIONS (`<testId>-page`), CapabilityForm (`video-form-*`,
 * `music-form-*`), AudioStudioWorkspace (`speech-studio-*`, `sound-effects-studio-*`),
 * StudioGallery (`<gallery>-empty`, ...), GeneratedAudioCard and MediaPlayer.
 */
export class StudioPage extends BasePage {
  /** The page root for a modality, e.g. `video-studio-page`. */
  pageRoot(modality: StudioModality): Locator {
    return this.page.getByTestId(`${modality}-studio-page`);
  }

  tab(modality: StudioModality): Locator {
    return this.page.getByTestId(`studio-tab-${modality}`);
  }

  async goto(modality: StudioModality) {
    await this.page.goto(`/studio/${modality}`);
    await this.page.waitForLoadState('domcontentloaded');
    await this.handleGearsDiscoveryModal();
    await this.dismissModals();
    await this.waitForModality(modality);
  }

  /** Waits for the modality's page and for its form to pass the models/providers gate. */
  async waitForModality(modality: StudioModality) {
    await expect(this.page).toHaveURL(new RegExp(`/studio/${modality}(?:[?#]|$)`), { timeout: TIMEOUTS.NAVIGATION });
    await expect(this.pageRoot(modality)).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await expect(this.tab(modality)).toHaveAttribute('aria-selected', 'true');
    await expect(this.form(modality)).toBeVisible({ timeout: TIMEOUTS.ACTION });
  }

  form(modality: StudioModality): Locator {
    if (modality === 'video' || modality === 'music') return this.page.getByTestId(`${modality}-form`);
    return this.page.getByTestId(`${modality}-studio-form`);
  }

  // ---------------------------------------------------------------------------
  // Audio (speech, sound effects)
  // ---------------------------------------------------------------------------

  audioTextInput(mode: AudioMode): Locator {
    return this.page.getByTestId(`${mode}-studio-text-input`).locator('textarea').first();
  }

  audioSubmit(mode: AudioMode): Locator {
    return this.page.getByTestId(`${mode}-studio-submit-btn`);
  }

  audioEstimate(mode: AudioMode): Locator {
    return this.page.getByTestId(`${mode}-studio-credit-estimate`);
  }

  /** The generated card whose prompt is exactly `prompt` (prompts carry a per-run marker). */
  audioCard(prompt: string): Locator {
    return this.page
      .getByTestId('generated-audio-card')
      .filter({ has: this.page.getByTestId('generated-audio-card-prompt').getByText(prompt, { exact: true }) });
  }

  /**
   * Types `prompt`, clicks Generate and waits for the endpoint to answer. Returns the response so a
   * failure reports the server's status rather than a missing gallery card.
   */
  async generateAudio(mode: AudioMode, prompt: string): Promise<Response> {
    await this.audioTextInput(mode).fill(prompt);
    await expect(this.audioSubmit(mode)).toBeEnabled();
    const responsePromise = this.page.waitForResponse(
      r => r.request().method() === 'POST' && AUDIO_ENDPOINT[mode].test(new URL(r.url()).pathname),
      { timeout: AUDIO_GENERATION_TIMEOUT }
    );
    await this.audioSubmit(mode).click();
    return responsePromise;
  }

  /**
   * Waits for the card's audio element to load real media: MediaPlayer withholds `src` until the
   * file's moderation scan clears (up to 30 s), then the element must report a finite duration.
   */
  async expectPlayableAudio(card: Locator) {
    const audio = card.getByTestId('media-player-audio');
    await expect(card.getByTestId('media-player-error')).toHaveCount(0);
    await expect(audio).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await expect(audio).toHaveAttribute('src', /^https?:\/\//, { timeout: 45_000 });
    await expect
      .poll(
        () =>
          audio.evaluate(async (el: HTMLAudioElement) => {
            if (el.readyState < 1) {
              el.preload = 'metadata';
              el.load();
              await new Promise<void>(resolve => {
                const done = () => resolve();
                el.addEventListener('loadedmetadata', done, { once: true });
                el.addEventListener('error', done, { once: true });
                setTimeout(done, 5_000);
              });
            }
            return Number.isFinite(el.duration) ? el.duration : 0;
          }),
        { timeout: TIMEOUTS.ACTION, message: 'generated audio never reported a duration' }
      )
      .toBeGreaterThan(0);
  }
}
