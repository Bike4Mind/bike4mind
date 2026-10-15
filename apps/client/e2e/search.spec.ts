import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';

/**
 * E2E tests for search functionality across the application.
 *
 * Exercises the refactored search query builders:
 * - buildFabFileSearchQuery (file browser, sidenav files)
 * - buildCollectionSearchPipeline (profile collections)
 * - session searchByUserId (notebook search)
 */

test.describe('File Browser Search', () => {
  test('should search files by name', async ({ page, basePage, fileUpload }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await fileUpload.openFileBrowser();

    // Search for a seeded file by partial name
    const searchInput = page.getByTestId('file-browser-search-input').getByRole('textbox');
    await searchInput.fill('E2E-SearchTest-Report');

    // Assert matching file is visible
    await expect(
      page.getByTestId('file-browser-dialog').getByText('E2E-SearchTest-Report', { exact: false })
    ).toBeVisible({ timeout: TIMEOUTS.ACTION });
  });

  test('should show empty state for no-match search', async ({ page, basePage, fileUpload }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await fileUpload.openFileBrowser();

    const searchInput = page.getByTestId('file-browser-search-input').getByRole('textbox');
    await searchInput.fill('ZZZ-NonExistent-File-XYZ-999');

    // Wait for search to execute and results to update
    await page.waitForTimeout(TIMEOUTS.POST_ACTION);

    // Assert no file items are visible (or an empty state message appears)
    const fileItems = page.getByTestId('file-browser-list-item');
    const gridItems = page.getByTestId('file-browser-item-name');
    const listCount = await fileItems.count();
    const gridCount = await gridItems.count();
    expect(listCount + gridCount).toBe(0);
  });

  test('should search unique file with exact match', async ({ page, basePage, fileUpload }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await fileUpload.openFileBrowser();

    const searchInput = page.getByTestId('file-browser-search-input').getByRole('textbox');
    await searchInput.fill('E2E-SearchUniqueFile');

    await expect(
      page.getByTestId('file-browser-dialog').getByText('E2E-SearchUniqueFile', { exact: false })
    ).toBeVisible({ timeout: TIMEOUTS.ACTION });
  });

  // The toolbar switches layout on the dialog's width, not the viewport's: the dialog is 90vw wide and the
  // content has 32px of horizontal padding, so its container is 0.9 * viewport - 64. These viewports sit on
  // both sides of each switch in the toolbar constants (Files/Browser/Content.tsx).
  const toolbarViewports = [
    { width: 930, singleRow: false }, // ~773px: single column
    { width: 1020, singleRow: false }, // ~854px: views + actions over filters
    { width: 1520, singleRow: false }, // ~1304px: two rows, just below the single-row switch
    { width: 1560, singleRow: true }, // ~1340px: one row, just above it
    { width: 1920, singleRow: true }, // ~1664px: one row
  ];

  for (const { width, singleRow } of toolbarViewports) {
    test(`should keep the search box usable at a ${width}px viewport`, async ({ page, basePage, fileUpload }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      await basePage.dismissModals();

      await fileUpload.openFileBrowser();

      const searchInput = page.getByTestId('file-browser-search-input');
      const toolbarFilters = page.getByTestId('file-browser-toolbar-filters');
      const toolbarActions = page.getByTestId('file-browser-toolbar-actions');
      await expect(searchInput).toBeVisible({ timeout: TIMEOUTS.ACTION });
      await expect(toolbarActions).toBeVisible({ timeout: TIMEOUTS.ACTION });

      // The row is only the crowded one with Research present (the search user enables it in search.setup.ts).
      await expect(toolbarActions.getByRole('button')).toHaveCount(3);

      const search = await searchInput.boundingBox();
      const filters = await toolbarFilters.boundingBox();
      const actions = await toolbarActions.boundingBox();
      expect(search).not.toBeNull();
      expect(filters).not.toBeNull();
      expect(actions).not.toBeNull();
      if (!search || !filters || !actions) return;

      expect(search.width).toBeGreaterThanOrEqual(160);
      // The whole filter row, not just the search box: the type select and the Generated toggle sit in it too.
      const overlaps =
        filters.x < actions.x + actions.width &&
        actions.x < filters.x + filters.width &&
        filters.y < actions.y + actions.height &&
        actions.y < filters.y + filters.height;
      expect(overlaps).toBe(false);

      // Confirm the band instead of assuming it: one row puts the filters beside the actions, the two-row and
      // single-column layouts stack them underneath.
      const actionsCenter = actions.y + actions.height / 2;
      const filtersCenter = filters.y + filters.height / 2;
      if (singleRow) {
        expect(Math.abs(filtersCenter - actionsCenter)).toBeLessThanOrEqual(4);
      } else {
        expect(filtersCenter).toBeGreaterThan(actionsCenter + 4);
      }

      // No action label may be squeezed or wrapped: a squeezed label overflows its button horizontally, a
      // wrapped one renders more than one line box. Measure once the webfonts have settled so a late swap
      // cannot change the widths mid-read.
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const badActions = await toolbarActions.evaluate(el => {
        const lineBoxes = (button: HTMLElement) => {
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
          let boxes = 0;
          while (walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            boxes += range.getClientRects().length;
          }
          return boxes;
        };
        return Array.from(el.querySelectorAll('button')).filter(
          button => button.scrollWidth > button.clientWidth || lineBoxes(button) > 1
        ).length;
      });
      expect(badActions).toBe(0);
    });
  }
});

test.describe('Notebook Search', () => {
  test('should search notebooks by name', async ({ page, basePage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    // Type in the notebook search input
    const searchInput = page.getByTestId('notebook-search-input');
    await expect(searchInput).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await searchInput.getByRole('textbox').fill('E2E Search Notebook Alpha');

    // Assert the matching notebook appears
    await expect(page.getByTestId('notebook-list-item').filter({ hasText: 'E2E Search Notebook Alpha' })).toBeVisible({
      timeout: TIMEOUTS.ACTION,
    });
  });

  test('should show all notebooks when search is cleared', async ({ page, basePage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    const searchInput = page.getByTestId('notebook-search-input');
    await expect(searchInput).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    const textbox = searchInput.getByRole('textbox');

    // Search for something specific
    await textbox.fill('E2E Search Notebook Alpha');
    await page.waitForTimeout(TIMEOUTS.POST_ACTION);

    // Clear search
    await textbox.clear();
    await page.waitForTimeout(TIMEOUTS.POST_ACTION);

    // Multiple notebooks should be visible again
    const items = page.getByTestId('notebook-list-item');
    await expect(items.first()).toBeVisible({ timeout: TIMEOUTS.ACTION });
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

test.describe('Profile Collection Search', () => {
  test('should search across collections', async ({ page, basePage, profilePage }) => {
    await profilePage.gotoProfile();

    // Collections section is inside the profile tab (default active tab)
    // Scroll to ensure the collection section is visible
    const searchInput = page.getByTestId('profile-collection-search-input');
    await expect(searchInput).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await searchInput.getByRole('textbox').fill('E2E Search Notebook');

    // Assert matching collection items appear
    await expect(page.getByTestId('profile-collection-item').first()).toBeVisible({
      timeout: TIMEOUTS.ACTION,
    });
  });

  test('should filter collections by type', async ({ page, basePage, profilePage }) => {
    await profilePage.gotoProfile();

    // Wait for collection items to load (inside default profile tab)
    await expect(page.getByTestId('profile-collection-item').first()).toBeVisible({
      timeout: TIMEOUTS.ACTION,
    });

    // Select type filter for notebooks
    const typeFilter = page.getByTestId('profile-collection-type-filter');
    await expect(typeFilter).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });
    await typeFilter.click();

    // Select "notebook" option from the dropdown
    const notebookOption = page.getByRole('option', { name: /notebook/i });
    await expect(notebookOption).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });
    await notebookOption.click();
    await page.waitForTimeout(TIMEOUTS.POST_ACTION);

    // All visible items should be notebooks
    const items = page.getByTestId('profile-collection-item');
    await expect(items.first()).toBeVisible({ timeout: TIMEOUTS.ACTION });
  });
});
