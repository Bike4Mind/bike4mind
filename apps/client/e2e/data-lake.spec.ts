import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import {
  apiCreateDataLake,
  apiCreateFile,
  apiDeleteDataLake,
  apiListDataLakes,
  apiListDataLakesStatus,
  apiLakeLifecycle,
  apiSeedLakeArticle,
  apiUpdateDataLake,
  apiSetDataLakeVisibility,
  type DataLake,
} from './helpers/api';
import { getTestUsers } from './helpers/test-users';

const RUN = Date.now().toString().slice(-6);
const FIXTURE = path.resolve(__dirname, 'fixtures/uploads/recipe.txt');

/**
 * Build an in-memory upload whose content is unique per (RUN, label). Upload dedup is
 * scoped per-user by content hash (see /api/files/check-duplicates), NOT per-lake, so
 * success-path upload tests that reused the shared FIXTURE poisoned each other: the first
 * upload registered the hash and every later one got "All files are duplicates (skipped)".
 * Appending a unique marker gives each test a distinct hash. Use FIXTURE (verbatim) only
 * where a duplicate is intentional (the conflict-resolution test) or nothing is uploaded
 * (taxonomy/source steps).
 */
function uniqueUpload(label: string): { name: string; mimeType: string; buffer: Buffer }[] {
  const bytes = fs.readFileSync(FIXTURE);
  const buffer = Buffer.concat([bytes, Buffer.from(`\n# e2e-unique ${RUN} ${label}\n`)]);
  return [{ name: `recipe-${label}-${RUN}.txt`, mimeType: 'text/plain', buffer }];
}

// Track every lake created via API so we can purge them regardless of which test made them.
const created: string[] = [];

function ownerToken(): string {
  const { specUsers } = getTestUsers();
  const owner = specUsers.dataLake;
  if (!owner) throw new Error('data-lake spec user missing — data-lake.setup.ts must run first');
  return owner.accessToken;
}

async function seedLake(
  request: Parameters<typeof apiCreateDataLake>[0],
  token: string,
  overrides: Parameters<typeof apiCreateDataLake>[2]
): Promise<DataLake> {
  const lake = await apiCreateDataLake(request, token, overrides);
  created.push(lake.id);
  return lake;
}

/** Look up a lake the wizard created (by exact name), register it for teardown, and return it. */
async function trackLakeByName(
  request: Parameters<typeof apiListDataLakes>[0],
  token: string,
  name: string
): Promise<DataLake | undefined> {
  const lakes = await apiListDataLakes(request, token);
  const lake = lakes.find(l => l.name === name);
  if (lake) created.push(lake.id);
  return lake;
}

test.afterAll(async ({ request }) => {
  const token = ownerToken();
  for (const id of created) {
    await apiDeleteDataLake(request, token, id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature gating (smoke that setup enabled EnableDataLakes)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - feature gate', () => {
  test('list endpoint is enabled for the owner (setup flipped EnableDataLakes)', async ({ request }) => {
    const status = await apiListDataLakesStatus(request, ownerToken());
    expect(status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// List panel & management UI
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - management panel', () => {
  test('opens the manager and lists a seeded lake with its tag-prefix chip', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E List ${RUN}`,
      fileTagPrefix: `e2elist${RUN}:`,
    });

    await dataLakePage.openManagerFromHome();

    const card = dataLakePage.card(lake.id);
    await expect(card).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(card).toContainText(`E2E List ${RUN}`);
    await expect(card).toContainText(`e2elist${RUN}:`);
  });

  test('Create button opens the wizard', async ({ dataLakePage }) => {
    await dataLakePage.openManagerFromHome();
    await dataLakePage.startCreate();
    await expect(dataLakePage.wizardModal).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create wizard (drive the steps we can without a live S3/vectorize upload)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - create wizard', () => {
  test('step gating: Next is disabled until files are selected, enabled after', async ({ dataLakePage }) => {
    await dataLakePage.openManagerFromHome();
    await dataLakePage.startCreate();

    // 5-step CREATE order shown in the indicator.
    await expect(dataLakePage.wizardStepIndicator).toBeVisible();

    // Source step: no files -> Next disabled.
    await expect(dataLakePage.wizardNextBtn).toBeDisabled();

    // Select a file -> Next enables and advances the wizard off the source step.
    // (A flat, single-file selection has no folder structure to review, so the wizard
    // skips the preview step straight to AI Taxonomy — assert we advanced, not the
    // specific next step.)
    await dataLakePage.selectFiles([FIXTURE]);
    await dataLakePage.wizardNext();
    await expect(dataLakePage.wizardSourceStep).toBeHidden({ timeout: TIMEOUTS.VISIBLE });
  });

  test('closing with loaded files prompts the unsaved-progress confirm', async ({ dataLakePage }) => {
    await dataLakePage.openManagerFromHome();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles([FIXTURE]);
    await dataLakePage.wizardNext();

    await dataLakePage.closeWizardAcceptingConfirm();
    await expect(dataLakePage.wizardModal).toBeHidden({ timeout: TIMEOUTS.MODAL });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Append mode
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - append mode', () => {
  test('add-files wizard opens titled for the target lake', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Append ${RUN}`,
      fileTagPrefix: `e2eappend${RUN}:`,
    });

    await dataLakePage.openManagerFromHome();
    await dataLakePage.startAppend(lake.id);

    // Header reads "Add Files — <name>" (em-dash); match loosely to avoid dash-char pitfalls.
    await expect(dataLakePage.wizardModal).toContainText('Add Files', { timeout: TIMEOUTS.MODAL });
    await expect(dataLakePage.wizardModal).toContainText(`E2E Append ${RUN}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle (archive → deleted → purge) through the UI
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - lifecycle', () => {
  test('archive moves the lake to the Archived section', async ({ request, dataLakePage }) => {
    test.setTimeout(2 * TIMEOUTS.TEST);
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Archive ${RUN}`,
      fileTagPrefix: `e2earch${RUN}:`,
    });

    await dataLakePage.openManagerFromHome();
    await expect(dataLakePage.card(lake.id)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    await dataLakePage.archive(lake.id);
    await dataLakePage.expandArchived();
    await expect(dataLakePage.page.getByTestId(`datalake-archived-section-card-${lake.id}`)).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  });

  test('purge confirmation dialog appears and irreversibly removes a deleted lake', async ({
    request,
    dataLakePage,
  }) => {
    // Fast-path the lake into the recoverable-deleted state via API, then purge through the UI.
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Purge ${RUN}`,
      fileTagPrefix: `e2epurge${RUN}:`,
    });
    expect(await apiLakeLifecycle(request, ownerToken(), lake.id, 'archive')).toBe(200);
    expect(await apiLakeLifecycle(request, ownerToken(), lake.id, 'delete')).toBe(200);

    await dataLakePage.openManagerFromHome();
    await dataLakePage.expandDeleted();
    await expect(dataLakePage.page.getByTestId(`datalake-deleted-section-card-${lake.id}`)).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });

    await dataLakePage.purge(lake.id);
    await expect(dataLakePage.page.getByTestId(`datalake-deleted-section-card-${lake.id}`)).toBeHidden({
      timeout: TIMEOUTS.ACTION,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings modal (rename + gate can't-clear rule)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - settings', () => {
  test('rename a lake via the settings modal', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Rename ${RUN}`,
      fileTagPrefix: `e2eren${RUN}:`,
    });
    const renamed = `E2E Renamed ${RUN}`;

    await dataLakePage.openManagerFromHome();
    await dataLakePage.openSettings(lake.id);

    await dataLakePage.fillSettingsField('datalake-settings-name', renamed);
    await dataLakePage.saveSettings();
    await dataLakePage.waitForToast('Data lake updated');

    await expect(dataLakePage.card(lake.id)).toContainText(renamed, { timeout: TIMEOUTS.VISIBLE });
  });

  test('an existing access gate cannot be cleared from settings (warning + kept)', async ({
    request,
    dataLakePage,
  }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Gate ${RUN}`,
      fileTagPrefix: `e2egate${RUN}:`,
      requiredUserTag: 'e2e-datalake',
    });

    await dataLakePage.openManagerFromHome();
    await dataLakePage.openSettings(lake.id);

    // Blank the previously-set access tag and save — the backend rejects clearing, and the
    // UI warns that the existing tag was kept.
    await dataLakePage.fillSettingsField('datalake-settings-usertag', '');
    await dataLakePage.saveSettings();
    await dataLakePage.waitForToast('not cleared');
  });

  test('org visibility is disabled in a personal (non-team) context', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Vis ${RUN}`,
      fileTagPrefix: `e2evis${RUN}:`,
    });

    await dataLakePage.openManagerFromHome();
    await dataLakePage.openSettings(lake.id);

    // The seeded spec user has no team org, so promotion to "Organization" is not offered.
    await expect(dataLakePage.orgVisibilityRadioInput).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Viewer
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - viewer', () => {
  test('opens the viewer with a filterable tree', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Viewer ${RUN}`,
      fileTagPrefix: `e2eview${RUN}:`,
    });

    await dataLakePage.openManagerFromHome();
    await dataLakePage.openViewer(lake.id);

    await expect(dataLakePage.viewer).toBeVisible();
    await expect(dataLakePage.viewerTree).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    // The filter input is present and accepts input (empty lake shows no categories).
    await dataLakePage.searchViewer('nothing-matches-this');
    await expect(dataLakePage.viewer).toContainText(/No matches|No categories|No files/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group N — Sharing & permissions (server-side boundary, asserted via API tokens)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - sharing & permissions', () => {
  test('a private lake is not visible to another user', async ({ request }) => {
    const { manager } = getTestUsers();
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Private ${RUN}`,
      fileTagPrefix: `e2epriv${RUN}:`,
    });

    const ownerLakes = await apiListDataLakes(request, ownerToken());
    expect(ownerLakes.map(l => l.id)).toContain(lake.id);

    const managerLakes = await apiListDataLakes(request, manager.accessToken);
    expect(managerLakes.map(l => l.id)).not.toContain(lake.id);
  });

  test('a tag-gated lake is hidden from a user without the required tag', async ({ request }) => {
    const { manager } = getTestUsers();
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E TagGate ${RUN}`,
      fileTagPrefix: `e2etag${RUN}:`,
      requiredUserTag: `e2e-nobody-${RUN}`,
    });

    const managerLakes = await apiListDataLakes(request, manager.accessToken);
    expect(managerLakes.map(l => l.id)).not.toContain(lake.id);
  });

  test('an entitlement-gated lake is hidden from a user without the entitlement', async ({ request }) => {
    const { manager } = getTestUsers();
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E EntGate ${RUN}`,
      fileTagPrefix: `e2eent${RUN}:`,
      requiredEntitlement: `e2e:only-${RUN}`,
    });

    const managerLakes = await apiListDataLakes(request, manager.accessToken);
    expect(managerLakes.map(l => l.id)).not.toContain(lake.id);
  });

  test('a non-owner cannot archive or update a lake they do not own', async ({ request }) => {
    const { manager } = getTestUsers();
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E NoControl ${RUN}`,
      fileTagPrefix: `e2enoctl${RUN}:`,
    });

    const archiveStatus = await apiLakeLifecycle(request, manager.accessToken, lake.id, 'archive');
    expect(archiveStatus).toBeGreaterThanOrEqual(400);

    const updateStatus = await apiUpdateDataLake(request, manager.accessToken, lake.id, { name: 'hijacked' });
    expect(updateStatus).toBeGreaterThanOrEqual(400);
  });

  test('sharing a lake to an organization requires a team context (rejected in personal scope)', async ({
    request,
  }) => {
    // The seeded owner is in a personal context only, so promotion to organization visibility
    // has no target org and the server rejects it. (Full cross-org member-visibility is a
    // multi-org fixture not modeled here — see data-lake.scenarios.md N1/N10.)
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E OrgShare ${RUN}`,
      fileTagPrefix: `e2eorg${RUN}:`,
    });
    const status = await apiSetDataLakeVisibility(request, ownerToken(), lake.id, 'organization');
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group A/E — Full create-to-upload through the wizard UI
// (Upload "complete" fires when the S3 puts finish — it does NOT wait for
// vectorization — so this is fast with a small file. Taxonomy runs a real AI call.)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - create wizard (full upload)', () => {
  test('creates a lake end-to-end: source -> taxonomy -> config -> upload complete', async ({
    request,
    dataLakePage,
  }) => {
    test.setTimeout(3 * TIMEOUTS.TEST);
    const name = `E2E Create Full ${RUN}`;

    await dataLakePage.openManagerFromHome();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles(uniqueUpload('full'));
    await dataLakePage.advanceToConfig();

    await dataLakePage.fillMuiInput(dataLakePage.configNameInput, name);
    await dataLakePage.fillMuiInput(dataLakePage.configTagPrefixInput, `e2efull${RUN}:`);
    await dataLakePage.startUploadAndWaitComplete();

    // The lake now exists server-side.
    const lake = await trackLakeByName(request, ownerToken(), name);
    expect(lake, 'created lake should be listed').toBeTruthy();
  });

  test('access-tag + entitlement gates set via the wizard persist on the lake', async ({ request, dataLakePage }) => {
    test.setTimeout(3 * TIMEOUTS.TEST);
    const name = `E2E Create Gated ${RUN}`;

    await dataLakePage.openManagerFromHome();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles(uniqueUpload('gated'));
    await dataLakePage.advanceToConfig();

    await dataLakePage.fillMuiInput(dataLakePage.configNameInput, name);
    await dataLakePage.fillMuiInput(dataLakePage.configTagPrefixInput, `e2egated${RUN}:`);
    await dataLakePage.fillMuiInput(dataLakePage.configAccessTagInput, 'e2e-datalake');
    await dataLakePage.fillMuiInput(dataLakePage.configEntitlementInput, `e2e:pro-${RUN}`);
    await dataLakePage.startUploadAndWaitComplete();

    const lake = await trackLakeByName(request, ownerToken(), name);
    expect(lake, 'gated lake should be listed').toBeTruthy();

    // Reopen its settings and confirm the gates were persisted.
    await dataLakePage.openManagerFromHome();
    await dataLakePage.openSettings(lake!.id);
    await expect(dataLakePage.settingsModal.getByTestId('datalake-settings-usertag').locator('input')).toHaveValue(
      'e2e-datalake'
    );
    await expect(dataLakePage.settingsModal.getByTestId('datalake-settings-entitlement').locator('input')).toHaveValue(
      `e2e:pro-${RUN}`
    );
  });

  test('selecting a file that already exists surfaces the conflict-resolution UI', async ({
    request,
    dataLakePage,
  }) => {
    test.setTimeout(2 * TIMEOUTS.TEST);

    // Seed a FabFile whose content hash matches the fixture, so the config-step dedup check
    // (which hashes the selected file and calls /api/files/check-duplicates) flags it.
    const bytes = fs.readFileSync(FIXTURE);
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    await apiCreateFile(request, ownerToken(), {
      fileName: `dup-seed-${RUN}.txt`,
      content: bytes.toString('utf-8'),
      contentHash,
    });

    await dataLakePage.openManagerFromHome();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles([FIXTURE]);
    await dataLakePage.advanceToConfig();

    // Duplicate detected -> the conflict-resolution controls render.
    await expect(dataLakePage.configStep).toContainText(/Duplicate File Handling|already exist/i, {
      timeout: TIMEOUTS.ACTION,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group D — Taxonomy tag editing
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - taxonomy', () => {
  test('deleting a suggested tag removes it from the list', async ({ dataLakePage }) => {
    test.setTimeout(3 * TIMEOUTS.TEST);

    await dataLakePage.openManagerFromHome();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles([FIXTURE]);
    await dataLakePage.advanceToTaxonomy();

    const before = await dataLakePage.deleteFirstTaxonomyTag();
    expect(before).toBeGreaterThan(0);
    await expect(dataLakePage.taxonomyTagCards).toHaveCount(before - 1, { timeout: TIMEOUTS.VISIBLE });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group G — Append: full upload into an existing lake
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - append (full upload)', () => {
  test('uploads a file into an existing lake (no taxonomy step)', async ({ request, dataLakePage }) => {
    test.setTimeout(2 * TIMEOUTS.TEST);
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Append Full ${RUN}`,
      fileTagPrefix: `e2eappf${RUN}:`,
    });

    await dataLakePage.openManagerFromHome();
    await dataLakePage.startAppend(lake.id);
    await dataLakePage.selectFiles(uniqueUpload('appendf'));
    await dataLakePage.advanceToConfig(); // append skips taxonomy; config is pre-filled + locked
    await dataLakePage.startUploadAndWaitComplete();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group J — Viewer / explorer article (seeded via API to avoid the upload pipeline)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - explorer article', () => {
  test('"Ask about" an article prefills chat and navigates to a new session', async ({
    request,
    dataLakePage,
    page,
  }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E AskAbout ${RUN}`,
      fileTagPrefix: `e2eask${RUN}:`,
    });
    const fileId = await apiSeedLakeArticle(request, ownerToken(), lake, {
      fileName: `ask-about-${RUN}.txt`,
      content: 'Sinigang is a sour Filipino soup made with tamarind, pork, and vegetables.',
    });

    await dataLakePage.gotoArticle(fileId);
    await dataLakePage.askAboutBtn.click();
    await expect(page).toHaveURL(/\/new/, { timeout: TIMEOUTS.NAVIGATION });
  });

  test('the sort toggle flips sort state', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Sort ${RUN}`,
      fileTagPrefix: `e2esort${RUN}:`,
    });
    // Two articles so the tree has content to sort.
    await apiSeedLakeArticle(request, ownerToken(), lake, { fileName: `sort-a-${RUN}.txt`, content: 'alpha one' });
    await apiSeedLakeArticle(request, ownerToken(), lake, { fileName: `sort-b-${RUN}.txt`, content: 'beta two' });

    await dataLakePage.gotoDataLakes();
    await expect(dataLakePage.sortToggle).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    // No dedicated hook for sort state; the Joy IconButton variant flips plain -> soft on toggle.
    await expect(dataLakePage.sortToggle).toHaveClass(/variantPlain/);
    await dataLakePage.sortToggle.click();
    await expect(dataLakePage.sortToggle).toHaveClass(/variantSoft/);
  });
});
