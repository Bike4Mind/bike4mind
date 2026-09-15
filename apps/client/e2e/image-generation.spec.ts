import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';

test.describe('Image Generation', () => {
  test.beforeEach(async ({ page, basePage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();
  });

  test('should generate an image from prompt', async ({ navigationPage, chatPage, modelSelector }) => {
    // Budget = IMAGE_GENERATION (long pole: image render) + AI_RESPONSE (streaming) + TEST (setup).
    // See constants.ts (TIMEOUTS.IMAGE_GENERATION) for the rationale on each component.
    test.setTimeout(TIMEOUTS.IMAGE_GENERATION + TIMEOUTS.AI_RESPONSE + TIMEOUTS.TEST);

    await navigationPage.navigateToNewChat();
    await modelSelector.selectImageModel('GPT-Image-1');

    await chatPage.sendImageMessageAndWaitForResponse('Give me an image of a dog?', TIMEOUTS.AI_RESPONSE);

    const img = await chatPage.waitForImageResponse(TIMEOUTS.IMAGE_GENERATION);

    // Verify image dimensions
    const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
    const naturalHeight = await img.evaluate((el: HTMLImageElement) => el.naturalHeight);
    expect(naturalWidth).toBeGreaterThan(0);
    expect(naturalHeight).toBeGreaterThan(0);

    // Verify image src is a valid image URL (works on any environment)
    const src = await img.getAttribute('src');
    expect(src).toMatch(/https?:\/\/.+\.(jpg|png|webp)/);
  });
});
