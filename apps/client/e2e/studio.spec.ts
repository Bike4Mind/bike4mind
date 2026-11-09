import { stat } from 'fs/promises';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { getTestUsers } from './helpers/test-users';
import {
  AUDIO_GENERATION_TIMEOUT,
  AUDIO_USAGE_TRANSACTION_TYPE,
  STUDIO_MODALITIES,
  parseAudioEstimate,
  type AudioMode,
  type StudioPage,
} from './pages/StudioPage';

const parseCredits = (text: string | null): number => Number((text ?? '').replace(/[^0-9]/g, ''));

test.describe('Studio - navigation', () => {
  test('sidenav More menu opens Studio on the first usable tab', async ({ page, basePage, studioPage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await studioPage.handleGearsDiscoveryModal();
    await basePage.dismissModals();

    await page.getByTestId('sidenav-nav-more').click();
    await page.getByTestId('sidenav-more-studio').click();

    await studioPage.waitForModality('video');
    await expect(page).toHaveTitle(/Video Studio/);
  });

  test('each tab has its own URL and shows its gallery', async ({ page, studioPage }) => {
    await studioPage.goto('video');
    await expect(page.getByTestId('studio-tabs').getByRole('tab')).toHaveText([
      'Video',
      'Music',
      'Speech',
      'Sound effects',
    ]);

    // The galleries are empty for a fresh user, except speech/sound effects once the generation
    // tests below have run on a retry - so accept either the empty state or a populated gallery.
    const galleries = {
      video: 'video-gallery',
      music: 'music-gallery',
      speech: 'speech-gallery',
      'sound-effects': 'sound-effects-gallery',
    } as const;

    for (const modality of STUDIO_MODALITIES) {
      await test.step(`switch to ${modality}`, async () => {
        await studioPage.tab(modality).click();
        await studioPage.waitForModality(modality);
        const gallery = galleries[modality];
        await expect(page.getByTestId(`${gallery}-empty`).or(page.getByTestId(gallery))).toBeVisible({
          timeout: TIMEOUTS.ACTION,
        });
        await expect(page.getByTestId(`${gallery}-error`)).toHaveCount(0);
      });
    }

    await test.step('browser back returns to the previous tab', async () => {
      await page.goBack();
      await studioPage.waitForModality('speech');
    });

    // A fresh load of the tab's URL, not page.reload(): a raw reload cold-boots on the shared refresh
    // cookie, which rotates it and revokes the session for the other tests (see e2e/README.md).
    await test.step('loading the tab URL directly opens that tab', async () => {
      await studioPage.goto('sound-effects');
    });
  });

  test('an unknown modality is a 404, not an empty page', async ({ page }) => {
    await page.goto('/studio/not-a-modality');
    await expect(page.getByTestId('notfound-page')).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await expect(page.getByTestId('studio-tabs')).toHaveCount(0);
  });
});

test.describe('Studio - video and music forms', () => {
  test('video form validates the prompt, mode and estimate without submitting', async ({ page, studioPage }) => {
    await studioPage.goto('video');
    const submit = page.getByTestId('video-form-submit-btn');
    const prompt = page.getByTestId('video-form-prompt-input');
    const estimate = page.getByTestId('video-form-estimate');

    await test.step('defaults: a model is picked, submit waits for a prompt', async () => {
      await expect(page.getByTestId('video-form-model-select')).not.toHaveText('');
      await expect(page.getByTestId('video-form-payer-note')).toBeVisible();
      await expect(estimate).toHaveText(/Estimated cost: [\d,]+ credits/);
      await expect(submit).toBeDisabled();
    });

    await test.step('whitespace is not a prompt; text enables submit', async () => {
      await prompt.fill('   ');
      await expect(submit).toBeDisabled();
      await prompt.fill('A paper boat drifting down a rainy street, close up');
      await expect(submit).toBeEnabled();
    });

    await test.step('image-to-video needs a picked image before it can submit', async () => {
      await page.getByTestId('video-form-mode-image_to_video-btn').click();
      await expect(page.getByTestId('video-form-image-pick-btn')).toBeVisible();
      await expect(submit).toBeDisabled();
      await page.getByTestId('video-form-mode-text_to_video-btn').click();
      await expect(page.getByTestId('video-form-image-pick-btn')).toHaveCount(0);
      await expect(submit).toBeEnabled();
    });

    await test.step('a longer duration raises the estimate', async () => {
      const slider = page.getByTestId('video-form-duration-slider');
      await slider.focus();
      await slider.press('Home');
      const shortest = parseCredits(await estimate.textContent());
      await slider.press('End');
      await expect.poll(async () => parseCredits(await estimate.textContent())).toBeGreaterThan(shortest);
    });
  });

  test('music form validates the prompt and inserts lyric snippets without submitting', async ({
    page,
    studioPage,
  }) => {
    await studioPage.goto('music');
    const submit = page.getByTestId('music-form-submit-btn');

    await expect(page.getByTestId('music-form-model-select')).not.toHaveText('');
    await expect(page.getByTestId('music-form-estimate')).toHaveText(/Estimated cost: [\d,]+ credits/);
    await expect(page.getByTestId('music-form-payer-note')).toBeVisible();
    await expect(submit).toBeDisabled();

    await page.getByTestId('music-form-prompt-input').fill('Upbeat lo-fi beat for studying, soft piano');
    await expect(submit).toBeEnabled();

    // Lyric snippets exist only for a model that takes user lyrics; the default staging model does.
    const verse = page.getByTestId('music-form-lyrics-verse-snippet-btn');
    await expect(verse).toBeVisible();
    await test.step('lyric snippet buttons insert section tags', async () => {
      const instrumental = page.getByTestId('music-form-instrumental-switch');
      if ((await instrumental.count()) > 0 && (await instrumental.isChecked())) await instrumental.click();
      await verse.click();
      await page.getByTestId('music-form-lyrics-chorus-snippet-btn').click();
      const lyrics = page.getByTestId('music-form-lyrics-input');
      await expect(lyrics).toHaveValue(/\[Verse\][\s\S]*\[Chorus\]/);
    });
  });
});

const studioAccessToken = (): string => getTestUsers().specUsers.studio.accessToken;

/**
 * Billing parity: the form's estimate is usdToCredits (ceil, floor 1) of the provider cost, and the
 * server settles usdToCreditsStochastic of the same cost (floor, plus 1 with the fractional chance).
 * So the charge is the estimate or one less, never more. Checked on the balance the user sees and on
 * the ledger row the endpoint writes.
 */
async function expectChargeMatchesEstimate(
  studioPage: StudioPage,
  mode: AudioMode,
  {
    balanceBefore,
    estimate,
    ledgerIdsBefore,
  }: { balanceBefore: number; estimate: number; ledgerIdsBefore: Set<string> }
) {
  const token = studioAccessToken();
  const type = AUDIO_USAGE_TRANSACTION_TYPE[mode];

  const newRows = async () =>
    (await studioPage.usageTransactions(token, type)).filter(row => !ledgerIdsBefore.has(String(row._id ?? row.id)));
  await expect
    .poll(async () => (await newRows()).length, {
      timeout: TIMEOUTS.ACTION,
      message: `no new ${type} ledger row after generating`,
    })
    .toBe(1);
  const [row] = await newRows();

  const charged = await studioPage.creditBalance(token).then(after => balanceBefore - after);
  const context = `${mode}: charged ${charged} for an estimate of ${estimate}`;
  expect(charged, context).toBeLessThanOrEqual(estimate);
  expect(charged, context).toBeGreaterThanOrEqual(estimate - 1);
  // The ledger row is the charge itself (credits are negative on a deduction).
  expect(row.credits, `${context}; ledger row ${JSON.stringify(row)}`).toBe(-charged);
}

/** Balance, shown estimate and existing ledger rows, read right before Generate is clicked. */
async function billingSnapshot(studioPage: StudioPage, mode: AudioMode) {
  const token = studioAccessToken();
  const rows = await studioPage.usageTransactions(token, AUDIO_USAGE_TRANSACTION_TYPE[mode]);
  return {
    balanceBefore: await studioPage.creditBalance(token),
    estimate: parseAudioEstimate(await studioPage.audioEstimate(mode).textContent()),
    ledgerIdsBefore: new Set(rows.map(row => String(row._id ?? row.id))),
  };
}

// Real generations: cheap, short audio only. Each prompt carries a per-run marker so the card
// lookup never matches a clip from an earlier attempt.
test.describe('Studio - generated media', () => {
  // One at a time: both generations charge the same balance, and the parity check reads its drop.
  test.describe.configure({ mode: 'serial' });

  test('speech: generate a clip billed at its estimate, play it, reuse its settings, download it', async ({
    page,
    studioPage,
  }) => {
    test.setTimeout(AUDIO_GENERATION_TIMEOUT + 3 * TIMEOUTS.TEST);
    // Long enough (about 300 characters) that the estimate is several credits, so the parity check is
    // not just the 1-credit minimum; still a fraction of a cent at provider prices.
    const prompt =
      `Studio check ${Date.now()}. ` +
      'This short clip confirms that speech generation works end to end. The text is read aloud once, saved ' +
      'to your files, listed in the gallery, and billed against the estimate shown before you pressed the ' +
      'generate button. Nothing else happens, and the clip can be deleted at any time.';

    await studioPage.goto('speech');

    await test.step('voice list and estimate render', async () => {
      await expect(page.getByTestId('audio-gen-provider-select')).toBeVisible();
      await expect(page.getByTestId('voice-sample-list')).toBeVisible({ timeout: TIMEOUTS.ACTION });
      await expect(studioPage.audioSubmit('speech')).toBeDisabled();
      await studioPage.audioTextInput('speech').fill(prompt);
      await expect(studioPage.audioEstimate('speech')).toHaveText(/~\d+ credits? estimated/);
    });

    await test.step('generate, and the charge matches the estimate', async () => {
      const snapshot = await billingSnapshot(studioPage, 'speech');
      expect(snapshot.estimate).toBeGreaterThan(0);
      const response = await studioPage.generateAudio('speech', prompt);
      expect(response.status(), `TTS answered ${response.status()}`).toBe(200);
      // The estimate prices the default provider; a fallback bills the vendor that did the work
      // (pages/api/ai/tts.ts), so name the swap instead of failing parity as a billing error.
      const fallbackFrom = response.headers()['x-b4m-tts-provider-fallback-from'];
      expect(
        fallbackFrom,
        `TTS fell back from ${fallbackFrom} to ${response.headers()['x-b4m-tts-provider']}`
      ).toBeUndefined();
      await expectChargeMatchesEstimate(studioPage, 'speech', snapshot);
    });

    const card = studioPage.audioCard(prompt);

    await test.step('the clip is saved and listed first in the gallery', async () => {
      await expect(card).toBeVisible({ timeout: TIMEOUTS.ACTION });
      await expect(page.getByTestId('generated-audio-card').first()).toHaveAttribute(
        'data-file-id',
        (await card.getAttribute('data-file-id'))!
      );
      await expect(card.getByTestId('generated-audio-card-settings')).not.toHaveText('');
    });

    await test.step('the media player loads playable audio', async () => {
      await studioPage.expectPlayableAudio(card);
    });

    await test.step('"Use these settings" puts the prompt back in the form', async () => {
      await studioPage.audioTextInput('speech').fill('');
      await card.getByTestId('generated-audio-card-reuse-btn').click();
      await expect(studioPage.audioTextInput('speech')).toHaveValue(prompt);
    });

    await test.step('download saves the clip', async () => {
      const downloadPromise = page.waitForEvent('download', { timeout: TIMEOUTS.ACTION });
      await card.getByTestId('media-player-download-btn').click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.(mp3|wav|ogg|opus|aac|flac|pcm)$/i);
      expect(await download.failure()).toBeNull();
      expect((await stat(await download.path())).size, 'downloaded clip is empty').toBeGreaterThan(0);
    });

    await test.step('the clip is still listed after a fresh load', async () => {
      await studioPage.goto('speech');
      await expect(card).toBeVisible({ timeout: TIMEOUTS.ACTION });
    });
  });

  test('sound effects: generate a clip billed at its estimate and play it from the gallery', async ({
    page,
    studioPage,
  }) => {
    test.setTimeout(AUDIO_GENERATION_TIMEOUT + 2 * TIMEOUTS.TEST);
    const prompt = `A single soft door knock ${Date.now()}`;

    await studioPage.goto('sound-effects');
    await expect(page.getByTestId('audio-gen-duration-slider')).toBeVisible();
    await expect(studioPage.audioEstimate('sound-effects')).toHaveText(/~\d+ credits? estimated/);

    await test.step('generate, and the charge matches the estimate', async () => {
      await studioPage.audioTextInput('sound-effects').fill(prompt);
      const snapshot = await billingSnapshot(studioPage, 'sound-effects');
      expect(snapshot.estimate).toBeGreaterThan(0);
      const response = await studioPage.generateAudio('sound-effects', prompt);
      expect(response.status(), `sound effects answered ${response.status()}`).toBe(200);
      await expectChargeMatchesEstimate(studioPage, 'sound-effects', snapshot);
    });

    const card = studioPage.audioCard(prompt);
    await expect(card).toBeVisible({ timeout: TIMEOUTS.ACTION });
    await studioPage.expectPlayableAudio(card);

    await test.step('the clip is not listed under speech', async () => {
      await studioPage.tab('speech').click();
      await studioPage.waitForModality('speech');
      // Wait for the gallery query to settle (list or empty state); otherwise the count below could pass
      // before the list loads.
      await expect(page.getByTestId('speech-gallery').or(page.getByTestId('speech-gallery-empty'))).toBeVisible({
        timeout: TIMEOUTS.ACTION,
      });
      await expect(studioPage.audioCard(prompt)).toHaveCount(0);
    });
  });
});
