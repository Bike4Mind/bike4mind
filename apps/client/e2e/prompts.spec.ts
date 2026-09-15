import { test } from './fixtures';
import { TIMEOUTS } from './constants';
import prompts from './fixtures/prompts.json';

test.describe('Prompts & AI Chat', () => {
  // Run in default mode (sequential, same worker) - tests share the same authenticated
  // user and parallel workers cause cross-contamination. Unlike 'serial', 'default'
  // doesn't skip remaining tests when one fails.
  test.describe.configure({ mode: 'default' });

  test.beforeEach(async ({ page, basePage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();
  });

  test('should send prompt and receive AI response', async ({
    navigationPage,
    chatPage,
    modelSelector,
    verifyAnswers,
  }) => {
    test.slow();

    await navigationPage.navigateToNewChat();
    await modelSelector.selectTextModel('GPT-4.1 Mini', { disableSmartTools: true });

    await chatPage.sendMessageAndWaitForResponse(prompts.capital.prompt);

    await verifyAnswers(prompts.capital.answer, { selector: '[data-testid="ai-response"]' });
  });

  test('should handle multiple sequential prompts', async ({
    navigationPage,
    chatPage,
    modelSelector,
    verifyAnswers,
  }) => {
    test.setTimeout(5 * TIMEOUTS.TEST);

    await navigationPage.navigateToNewChat();
    await modelSelector.selectTextModel('GPT-4.1 Mini', { disableSmartTools: true });

    // First prompt - general knowledge
    await chatPage.sendMessageAndWaitForResponse(prompts.capital.prompt);
    await verifyAnswers(prompts.capital.answer, { selector: '[data-testid="ai-response"]' });

    // Second prompt - general knowledge
    await chatPage.sendMessageAndWaitForResponse(prompts.movie.prompt);
    await verifyAnswers(prompts.movie.answer, { selector: '[data-testid="ai-response"]' });
  });

  test('should upload text file and answer questions about it', async ({
    navigationPage,
    chatPage,
    modelSelector,
    fileUpload,
    verifyAnswers,
  }) => {
    test.setTimeout(5 * TIMEOUTS.TEST);

    await navigationPage.navigateToNewChat();
    await modelSelector.selectTextModel('Claude 4.5 Haiku', { disableSmartTools: true });
    await fileUpload.uploadFile(prompts['txt-recipe'].filepath);

    const query = prompts['txt-recipe'].queries[0];
    await chatPage.sendMessageAndWaitForResponse(query.prompt);
    await verifyAnswers(query.answer, {
      logic: query.answerLogic as 'or',
      selector: '[data-testid="ai-response"]',
    });
  });

  test('should upload image and answer questions about it', async ({
    navigationPage,
    chatPage,
    modelSelector,
    fileUpload,
    verifyAnswers,
  }) => {
    test.setTimeout(5 * TIMEOUTS.TEST);

    await navigationPage.navigateToNewChat();
    await modelSelector.selectTextModel('Claude 4.5 Haiku', { disableSmartTools: true });
    await fileUpload.uploadFile(prompts['image-cat'].filepath);

    const query = prompts['image-cat'].queries[0];
    await chatPage.sendMessageAndWaitForResponse(query.prompt);
    await verifyAnswers(query.answer, {
      logic: query.answerLogic as 'or',
      selector: '[data-testid="ai-response"]',
    });
  });

  test('should upload PDF and answer questions about it', async ({
    navigationPage,
    chatPage,
    modelSelector,
    fileUpload,
    verifyAnswers,
  }) => {
    test.setTimeout(5 * TIMEOUTS.TEST);

    await navigationPage.navigateToNewChat();
    await modelSelector.selectTextModel('Claude 4.5 Haiku', { disableSmartTools: true });
    await fileUpload.uploadFile(prompts['pdf-lorem'].filepath);

    const query = prompts['pdf-lorem'].queries[0];
    await chatPage.sendMessageAndWaitForResponse(query.prompt, prompts['pdf-lorem'].timeout);
    await verifyAnswers(query.answer, {
      logic: query.answerLogic as 'or',
      selector: '[data-testid="ai-response"]',
    });
  });
});
