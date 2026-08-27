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
 * (the step-gating steps).
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
  if (!owner) throw new Error('data-lake spec user missing - data-lake.setup.ts must run first');
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

/**
 * Purge every lake the suite made. Concurrent, and on its own enlarged budget: each purge is a
 * delete + cleanup round-trip plus a poll until the server's sweep finishes, and the suite makes
 * ~18 lakes - serially that is well past the 60s a hook gets by default. Hooks take their timeout
 * from test.setTimeout called inside them.
 */
test.afterAll(async ({ request }) => {
  test.setTimeout(4 * TIMEOUTS.TEST);
  const token = ownerToken();
  // Never reject: a lake that resists teardown must not fail the run (global-teardown sweeps the
  // spec user anyway), and one rejection would abandon the lakes still queued behind it.
  await Promise.all(created.map(id => apiDeleteDataLake(request, token, id).catch(() => {})));
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
// In-chat surface - the only entry point now that /data-lakes is retired
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - in-chat surface', () => {
  test('the header pill turns a chat into the Data Lake surface', async ({ dataLakePage }) => {
    await dataLakePage.openChatSurface();

    // Tree left, chat right, with the footer actions that replace the old page header.
    await expect(dataLakePage.manageBtn).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(dataLakePage.createBtn).toBeVisible();
    // The pill is the on-switch only; once mode is on the tree's X is the way back out.
    await expect(dataLakePage.modeToggle).toBeHidden();
    await expect(dataLakePage.modeCloseBtn).toBeVisible();
  });

  test('the tree close button turns Data Lake mode back off', async ({ dataLakePage }) => {
    await dataLakePage.openChatSurface();

    await dataLakePage.modeCloseBtn.click();
    await expect(dataLakePage.explorer).toBeHidden({ timeout: TIMEOUTS.VISIBLE });
    await expect(dataLakePage.modeToggle).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  });

  test('the sort toggle flips sort state', async ({ dataLakePage }) => {
    await dataLakePage.openChatSurface();

    // Sort state is exposed via the stable data-sort attribute (defaults to count, flips to alpha).
    await expect(dataLakePage.sortToggle).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(dataLakePage.sortToggle).toHaveAttribute('data-sort', 'count');
    await dataLakePage.sortToggle.click();
    await expect(dataLakePage.sortToggle).toHaveAttribute('data-sort', 'alpha');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Management modal (two-pane: lakes/files nav left, lake details right)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - management panel', () => {
  test('opens the manager and shows a seeded lake with its tag-prefix chip', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E List ${RUN}`,
      fileTagPrefix: `e2elist${RUN}:`,
    });

    await dataLakePage.openManagerFromChat();

    // Root pane is the pick-a-lake hint; the lake's own chips live in its details pane.
    await expect(dataLakePage.managerOverview).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await dataLakePage.selectLake(lake.id);

    await expect(dataLakePage.lakeInfo).toContainText(`E2E List ${RUN}`);
    await expect(dataLakePage.lakeInfo).toContainText(`e2elist${RUN}:`);
  });

  test('the sidebar search narrows the lake list', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Search ${RUN}`,
      fileTagPrefix: `e2esearch${RUN}:`,
    });

    await dataLakePage.openManagerFromChat();
    await expect(dataLakePage.lakeRow(lake.id)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    await dataLakePage.fillMuiInput(dataLakePage.managerSearch, `nope-${RUN}`);
    await expect(dataLakePage.lakeRow(lake.id)).toBeHidden({ timeout: TIMEOUTS.VISIBLE });

    await dataLakePage.fillMuiInput(dataLakePage.managerSearch, `E2E Search ${RUN}`);
    await expect(dataLakePage.lakeRow(lake.id)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  });

  test('the sidebar Create button opens the wizard', async ({ dataLakePage }) => {
    await dataLakePage.openManagerFromChat();
    await dataLakePage.managerCreateBtn.click();
    await expect(dataLakePage.wizardModal).toBeVisible({ timeout: TIMEOUTS.MODAL });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create wizard (drive the steps we can without a live S3/vectorize upload)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - create wizard', () => {
  test('step gating: Next needs both files and a valid name, then advances', async ({ dataLakePage }) => {
    await dataLakePage.openChatSurface();
    await dataLakePage.startCreate();

    await expect(dataLakePage.wizardStepIndicator).toBeVisible();

    // Source step: nothing selected and nothing named -> Next disabled.
    await expect(dataLakePage.wizardNextBtn).toBeDisabled();

    // Files alone are not enough: identity is set here now, so the name gates Next too.
    await dataLakePage.selectFiles([FIXTURE]);
    await expect(dataLakePage.wizardNextBtn).toBeDisabled();

    // Name it -> Next enables and advances straight to Config (the optional step is off).
    await dataLakePage.fillLakeName(`E2E Gating ${RUN}`);
    await dataLakePage.wizardNext();
    await expect(dataLakePage.wizardSourceStep).toBeHidden({ timeout: TIMEOUTS.VISIBLE });
    await expect(dataLakePage.configStep).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  });

  test('opting into Preview splices it into the flow before Config', async ({ dataLakePage }) => {
    await dataLakePage.openChatSurface();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles([FIXTURE]);
    await dataLakePage.fillLakeName(`E2E Optin ${RUN}`);

    await dataLakePage.previewToggle.check();
    await dataLakePage.wizardNext();
    await expect(dataLakePage.previewStep).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  });

  test('AI tagging is a background opt-in, not a wizard step', async ({ dataLakePage }) => {
    await dataLakePage.openChatSurface();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles([FIXTURE]);
    await dataLakePage.fillLakeName(`E2E Taxonomy ${RUN}`);

    // Ticking it must NOT add a step: taxonomy now runs after the upload and is reviewed from
    // the manager, so the flow still goes source -> config. (The review panel itself needs a
    // completed AI batch, so it is out of reach of a deterministic UI test.)
    await dataLakePage.taxonomyToggle.check();
    await dataLakePage.wizardNext();
    await expect(dataLakePage.configStep).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    // ...and the opt-in reached the summary, which is what makes it a background job rather than
    // a checkbox that goes nowhere. This copy is gated on exactly `optionalSteps.taxonomy`, so it
    // pins the other half of this test's name without having to create a lake.
    await expect(dataLakePage.configStep).toContainText('run in the background after upload');
  });

  test('closing with loaded files prompts the unsaved-progress confirm', async ({ dataLakePage }) => {
    await dataLakePage.openChatSurface();
    await dataLakePage.startCreate();
    // Files can be gathered without leaving the source step now, so the confirm has to fire
    // here - this is exactly the case that would otherwise discard a selection silently.
    await dataLakePage.selectFiles([FIXTURE]);

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

    await dataLakePage.openLakeInManager(lake.id);
    await dataLakePage.startAppend(lake.id);

    // Header reads "Add Files \u2014 <name>"; matched loosely to avoid dash-char pitfalls.
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

    await dataLakePage.openLakeInManager(lake.id);

    await dataLakePage.archive(lake.id);
    // Archiving drops the lake, so the panel falls back to the root overview on its own.
    await expect(dataLakePage.managerOverview).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    await dataLakePage.expandArchived(lake.id);
    await expect(dataLakePage.archivedCard(lake.id)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
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

    await dataLakePage.openManagerFromChat();
    await dataLakePage.expandDeleted(lake.id);
    await expect(dataLakePage.deletedCard(lake.id)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    await dataLakePage.purge(lake.id);
    await expect(dataLakePage.deletedCard(lake.id)).toBeHidden({ timeout: TIMEOUTS.ACTION });
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

    await dataLakePage.openLakeInManager(lake.id);
    await dataLakePage.openSettings(lake.id);

    await dataLakePage.fillSettingsField('datalake-settings-name', renamed);
    await dataLakePage.saveSettings();
    await dataLakePage.waitForToast('Data lake updated');

    await expect(dataLakePage.lakeInfo).toContainText(renamed, { timeout: TIMEOUTS.VISIBLE });
  });

  test('an existing access gate can be cleared from settings', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Gate ${RUN}`,
      fileTagPrefix: `e2egate${RUN}:`,
      requiredUserTag: 'e2e-datalake',
    });

    await dataLakePage.openLakeInManager(lake.id);
    await expect(dataLakePage.lakeInfo).toContainText('e2e-datalake', { timeout: TIMEOUTS.VISIBLE });

    // Blank the previously-set access tag and save - an empty value removes the gate.
    await dataLakePage.openSettings(lake.id);
    await dataLakePage.fillSettingsField('datalake-settings-usertag', '');
    await dataLakePage.saveSettings();
    await dataLakePage.waitForToast('Data lake updated');

    // The gate chip is gone, and the un-gated lake is now publishable (the server refuses
    // publishing a gated lake, so this is the end-to-end proof the gate really cleared).
    await expect(dataLakePage.lakeInfo).not.toContainText('e2e-datalake', { timeout: TIMEOUTS.VISIBLE });
    await dataLakePage.openSettings(lake.id);
    await expect(dataLakePage.publicVisibilityRadioInput).toBeEnabled();
  });

  test('org visibility is disabled in a personal (non-team) context', async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Vis ${RUN}`,
      fileTagPrefix: `e2evis${RUN}:`,
    });

    await dataLakePage.openLakeInManager(lake.id);
    await dataLakePage.openSettings(lake.id);

    // The seeded spec user has no team org, so promotion to "Organization" is not offered.
    await expect(dataLakePage.orgVisibilityRadioInput).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Browsing a lake's files (the manager's nav replaces the old viewer modal)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - file browser', () => {
  test("a lake's files are browsable and open in the reader pane", async ({ request, dataLakePage }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Viewer ${RUN}`,
      fileTagPrefix: `e2eview${RUN}:`,
    });
    // Tag the file explicitly. Seeding with the meta-tag ALONE does not reach the nav's
    // synthetic Uncategorized bucket: the server's fallback tagger stamps `<prefix>uncategorized`
    // on a lake file that carries no content tag (see createDataLakeFallbackTagger), so it
    // arrives already categorised - under a folder literally named "uncategorized". Naming the
    // category here keeps the test off that server-owned name.
    const fileId = await apiCreateFile(request, ownerToken(), {
      fileName: `viewer-${RUN}.txt`,
      content: 'Sinigang is a sour Filipino soup made with tamarind, pork, and vegetables.',
      tags: [
        { name: lake.datalakeTag, strength: 1 },
        { name: `e2eview${RUN}:recipes`, strength: 1 },
      ],
    });

    await dataLakePage.openLakeInManager(lake.id);

    await expect(dataLakePage.managerNode('recipes')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await dataLakePage.managerNode('recipes').click();

    await expect(dataLakePage.managerFileRow(fileId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await dataLakePage.managerFileRow(fileId).click();
    await expect(dataLakePage.managerArticle).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(dataLakePage.managerArticle).toContainText(`viewer-${RUN}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group N - Sharing & permissions (server-side boundary, asserted via API tokens)
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
    // has no target org and the server rejects it. (Full cross-org member-visibility needs a
    // multi-org fixture not modeled here.)
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E OrgShare ${RUN}`,
      fileTagPrefix: `e2eorg${RUN}:`,
    });
    const status = await apiSetDataLakeVisibility(request, ownerToken(), lake.id, 'organization');
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group A/E - Full create-to-upload through the wizard UI
// (Upload "complete" fires when the S3 puts finish - it does NOT wait for
// vectorization - so this is fast with a small file.)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - create wizard (full upload)', () => {
  test('creates a lake end-to-end: source -> config -> upload complete', async ({ request, dataLakePage }) => {
    test.setTimeout(3 * TIMEOUTS.TEST);
    const name = `E2E Create Full ${RUN}`;

    await dataLakePage.openChatSurface();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles(uniqueUpload('full'));
    await dataLakePage.fillLakeName(name);
    await dataLakePage.advanceToConfig();

    // The name carries through from the source step rather than being retyped here.
    await expect(dataLakePage.configSummaryName).toContainText(name);
    await dataLakePage.fillMuiInput(dataLakePage.configTagPrefixInput, `e2efull${RUN}:`);
    await dataLakePage.startUploadAndWaitComplete();

    // The lake now exists server-side.
    const lake = await trackLakeByName(request, ownerToken(), name);
    expect(lake, 'created lake should be listed').toBeTruthy();
  });

  test('access-tag + entitlement gates set via the wizard persist on the lake', async ({ request, dataLakePage }) => {
    test.setTimeout(3 * TIMEOUTS.TEST);
    const name = `E2E Create Gated ${RUN}`;

    await dataLakePage.openChatSurface();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles(uniqueUpload('gated'));
    await dataLakePage.fillLakeName(name);
    await dataLakePage.advanceToConfig();

    await dataLakePage.fillMuiInput(dataLakePage.configTagPrefixInput, `e2egated${RUN}:`);
    await dataLakePage.fillMuiInput(dataLakePage.configAccessTagInput, 'e2e-datalake');
    await dataLakePage.fillMuiInput(dataLakePage.configEntitlementInput, `e2e:pro-${RUN}`);
    await dataLakePage.startUploadAndWaitComplete();

    const lake = await trackLakeByName(request, ownerToken(), name);
    expect(lake, 'gated lake should be listed').toBeTruthy();

    // Reopen its settings and confirm the gates were persisted.
    await dataLakePage.openLakeInManager(lake!.id);
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

    await dataLakePage.openChatSurface();
    await dataLakePage.startCreate();
    await dataLakePage.selectFiles([FIXTURE]);
    await dataLakePage.fillLakeName(`E2E Dup ${RUN}`);
    await dataLakePage.advanceToConfig();

    // Duplicate detected -> the conflict-resolution controls render.
    await expect(dataLakePage.configStep).toContainText(/Duplicate File Handling|already exist/i, {
      timeout: TIMEOUTS.ACTION,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group G - Append: full upload into an existing lake
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - append (full upload)', () => {
  test('uploads a file into an existing lake', async ({ request, dataLakePage }) => {
    test.setTimeout(2 * TIMEOUTS.TEST);
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Append Full ${RUN}`,
      fileTagPrefix: `e2eappf${RUN}:`,
    });

    await dataLakePage.openLakeInManager(lake.id);
    await dataLakePage.startAppend(lake.id);
    await dataLakePage.selectFiles(uniqueUpload('appendf'));
    await dataLakePage.advanceToConfig(); // config is pre-filled + locked in append mode
    await dataLakePage.startUploadAndWaitComplete();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group J - In-chat file actions (articles seeded via API to avoid the upload pipeline)
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Data Lake - in-chat file actions', () => {
  // The page's inline reader and its "Ask about this article" hand-off went away with the page:
  // the chat now sits beside the tree, so the article opens in the viewer and the hand-off is the
  // row's Attach-to-chat action below. What must NOT break is the shared link itself. `/data-lakes`
  // is redirect-only now and exists for exactly this, and the redirect is the fragile half - it
  // flips a Zustand store from `beforeLoad` and is deliberately ungated by EnableDataLakes, so a
  // change to validateSearch, the store flip or the redirect target breaks every shared link with
  // nothing else in the repo failing.
  test('a shared /data-lakes?article= link lands in the in-chat surface with the file open', async ({
    request,
    dataLakePage,
    page,
  }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E DeepLink ${RUN}`,
      fileTagPrefix: `e2edeep${RUN}:`,
    });
    // Marked per-run so the assertion below cannot match another test's seeded article.
    const body = `Sinigang is a sour Filipino soup. Deep link marker ${RUN}.`;
    const fileId = await apiSeedLakeArticle(request, ownerToken(), lake, {
      fileName: `deep-link-${RUN}.txt`,
      content: body,
    });

    await dataLakePage.gotoArticle(fileId);

    // Redirected off the page-less path into a chat...
    await expect(page).toHaveURL(/\/new/, { timeout: TIMEOUTS.NAVIGATION });
    // ...with Data Lake mode already on: gotoArticle never clicks the pill, and the pill hides
    // itself once mode is on, so its absence is the store flip in `beforeLoad` having happened.
    await expect(dataLakePage.modeToggle).toBeHidden();
    // ...and the deep-linked file actually open. Assert the file's CONTENT, not its name: the
    // name also sits in the preview's file-picker combobox, which is hidden here, so a
    // getByText(name) matches that first and fails on a page that is in fact correct.
    await expect(page.getByText(body)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  });

  test('attaching a lake file on /new mints the grounded session and navigates to it', async ({
    request,
    dataLakePage,
    page,
  }) => {
    const lake = await seedLake(request, ownerToken(), {
      name: `E2E Attach ${RUN}`,
      fileTagPrefix: `e2eattach${RUN}:`,
    });
    // A prefixed content tag as well as the lake meta-tag: the chat tree has no Uncategorized
    // bucket, so the file has to sit under a real category folder to be reachable at all.
    const fileId = await apiCreateFile(request, ownerToken(), {
      fileName: `attach-${RUN}.txt`,
      content: 'Sinigang is a sour Filipino soup made with tamarind, pork, and vegetables.',
      tags: [
        { name: lake.datalakeTag, strength: 1 },
        { name: `e2eattach${RUN}:recipes`, strength: 1 },
      ],
    });

    await dataLakePage.openChatSurface();

    // Drill into the lake's category to reach the file row.
    await expect(dataLakePage.treeNode(`e2eattach${RUN}`)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await dataLakePage.treeNode(`e2eattach${RUN}`).click();
    await dataLakePage.treeNode('recipes').click();

    await expect(dataLakePage.fileRow(fileId)).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await dataLakePage.attachFileToChat(fileId);

    // /new defers session creation to the first send; attaching a lake file creates the
    // grounded session up front and swaps the URL for the real notebook.
    await expect(page).toHaveURL(/\/notebooks\//, { timeout: TIMEOUTS.NAVIGATION });
  });
});
