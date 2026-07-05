import { test } from './fixtures';

test.describe('Notebook File Operations', () => {
  test('should upload, browse, rename, and delete a file', async ({ page, basePage, navigationPage, fileUpload }) => {
    test.slow();
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await test.step('upload a file to notebook', async () => {
      await navigationPage.navigateToNewChat();
      await fileUpload.uploadFile('e2e/fixtures/uploads/cat.png');
    });

    await test.step('add file to notebook via file browser', async () => {
      await fileUpload.openFileBrowser();
      await fileUpload.switchToListView();
      await fileUpload.sortByDateDescending();
      await fileUpload.addFileToNotebook('cat.png');
    });

    await test.step('rename a file', async () => {
      await fileUpload.openFileBrowser();
      await fileUpload.switchToListView();
      await fileUpload.renameFile('cat', 'RenamedFile');
    });

    await test.step('delete a file', async () => {
      await fileUpload.openFileBrowser();
      await fileUpload.switchToListView();
      await fileUpload.deleteFile('RenamedFile');
    });
  });
});
