import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { test, expect, type Page, type Request } from '@playwright/test';
import { TIMEOUTS } from './constants';
import { BasePage } from './pages/BasePage';
import { FileUploadPage } from './pages/FileUploadPage';
import { LoginPage } from './pages/LoginPage';
import { NavigationPage } from './pages/NavigationPage';
import {
  appPodsArgs,
  buildPayload,
  compareBytes,
  extractSignInCode,
  mutateOneBit,
  parseAppPods,
  podsWereReplaced,
  readUploadReadableConfig,
  restartAppArgs,
  rolloutStatusArgs,
  sha256Hex,
  wrongKeyUrl,
  type AppPod,
  type UploadReadableConfig,
} from './helpers/selfhost-upload-readable';

/**
 * Self-host check: an uploaded file stays readable, byte for byte, after a page reload and after
 * the app pod is replaced.
 *
 * Signs in through the login form (the code is read from Mailpit), uploads a fresh file through
 * the composer, then reads it back inside the page three times - straight after the upload, after
 * a reload, after `kubectl rollout restart` of the chart's app Deployment - and compares every
 * byte with what was uploaded. Each read asks the app for the file (GET /api/files/{id}) and
 * fetches the signed URL it returns, which is the path the file viewer uses. Between the first
 * and second read it also proves two reads fail: the signed URL re-pointed at another key, and a
 * key that has no object.
 *
 *   # from apps/client, with the app, Mailpit and the object store reachable from this machine
 *   # (selfhost/kubernetes/README.md, "Upload readability check")
 *   SELFHOST_URL=http://localhost:3000 SELFHOST_EMAIL=you@example.com \
 *     SELFHOST_KUBE_NAMESPACE=bike4mind-eval SELFHOST_REVISION=$(git rev-parse HEAD) \
 *     pnpm exec playwright test -c e2e/selfhost-upload-readable.config.ts --project=live
 *
 * Mutation proof: the same command with SELFHOST_MUTATE_EXPECTED=true flips one bit of the
 * reference bytes. That run must FAIL at all three reads; if it passes, the comparison is not
 * looking at the bytes. All variables are listed in helpers/selfhost-upload-readable.ts.
 *
 * Each run leaves one small file and one notebook behind in the account.
 */

const run = promisify(execFile);

/** Bounded so an unreachable API server fails the step by name instead of hanging the whole test. */
const kubectl = async (args: string[], timeoutMs = 60_000): Promise<string> => {
  try {
    return (await run('kubectl', args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs })).stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().slice(-600);
    throw new Error(
      `kubectl ${args.join(' ')} failed${stderr ? `: ${stderr}` : ` (no answer within ${timeoutMs}ms?)`}`
    );
  }
};

type BrowserRead =
  | { stage: 'read'; base64: string; fileUrl: string; filePath?: string }
  | { stage: 'metadata' | 'object'; status: number }
  | { stage: 'withheld'; moderationStatus?: string; status?: string }
  | { stage: 'threw'; message: string };

/** Fetch the file inside the page: the app's own record first, then the signed URL it carries. */
const readInBrowser = (page: Page, fileId: string, authorization: string): Promise<BrowserRead> =>
  page.evaluate(
    async ({ fileId, authorization }): Promise<BrowserRead> => {
      try {
        const meta = await fetch(`/api/files/${fileId}`, { headers: { Authorization: authorization } });
        if (!meta.ok) return { stage: 'metadata', status: meta.status };
        const file = (await meta.json()) as {
          fileUrl?: string;
          filePath?: string;
          moderationStatus?: string;
          status?: string;
        };
        // Withheld until the upload scan resolves the file; the caller polls.
        if (!file.fileUrl) return { stage: 'withheld', moderationStatus: file.moderationStatus, status: file.status };
        const object = await fetch(file.fileUrl, { cache: 'no-store' });
        if (!object.ok) return { stage: 'object', status: object.status };
        const bytes = new Uint8Array(await object.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return { stage: 'read', base64: btoa(binary), fileUrl: file.fileUrl, filePath: file.filePath };
      } catch (error) {
        return { stage: 'threw', message: String(error) };
      }
    },
    { fileId, authorization }
  );

type FetchOutcome = { ok: boolean; status: number; body?: string } | { ok: false; status: 0; threw: string };

/** A plain in-page GET, reporting a network-level refusal as a failure rather than throwing. */
const fetchInBrowser = (page: Page, url: string, authorization?: string): Promise<FetchOutcome> =>
  page.evaluate(
    async ({ url, authorization }): Promise<FetchOutcome> => {
      try {
        const res = await fetch(url, {
          cache: 'no-store',
          headers: authorization ? { Authorization: authorization } : undefined,
        });
        return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 2000) };
      } catch (error) {
        return { ok: false, status: 0, threw: String(error) };
      }
    },
    { url, authorization }
  );

/** IDs of the newest messages Mailpit holds for the account, newest first. */
async function mailpitMessageIds(config: UploadReadableConfig): Promise<string[]> {
  const search = `${config.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${config.email}"`)}&limit=20`;
  const found = await fetch(search, { signal: AbortSignal.timeout(10_000) });
  if (!found.ok) throw new Error(`Mailpit search answered HTTP ${found.status}`);
  return (((await found.json()) as { messages?: { ID: string }[] }).messages ?? []).map(m => m.ID);
}

/**
 * The sign-in code from the newest message that was not in Mailpit before the code was requested.
 * Told apart by ID, not by timestamp, so clock skew between this machine and the cluster is moot.
 */
async function signInCodeFromMailpit(config: UploadReadableConfig, seen: Set<string>): Promise<string | undefined> {
  const fresh = (await mailpitMessageIds(config)).find(id => !seen.has(id));
  if (!fresh) return undefined;
  const message = await fetch(`${config.mailpitUrl}/api/v1/message/${encodeURIComponent(fresh)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!message.ok) return undefined;
  return extractSignInCode(((await message.json()) as { Text?: string }).Text ?? '');
}

async function signIn(page: Page, config: UploadReadableConfig): Promise<void> {
  const login = new LoginPage(page);
  // Fails here, by name, when Mailpit is not reachable - before a code is spent on it.
  const seen = new Set(await mailpitMessageIds(config));
  await login.goto();
  await login.fillEmail(config.email);

  let code: string | undefined;
  await expect
    .poll(async () => (code = await signInCodeFromMailpit(config, seen).catch(() => undefined)), {
      timeout: 60_000,
      intervals: [2_000],
      message: `no sign-in code for the account reached Mailpit at ${config.mailpitUrl}`,
    })
    .toBeTruthy();
  await login.fillOtc(code!);
  await login.submitExpectingInlineRegister();

  // A new email lands on the inline username step instead of leaving /login.
  const usernameInput = page.getByTestId('login-register-username-input');
  await expect(async () => {
    expect((await usernameInput.isVisible()) || !page.url().includes('/login')).toBe(true);
  }).toPass({ timeout: TIMEOUTS.ACTION });
  if (page.url().includes('/login')) {
    await login.fillInlineRegisterUsername(config.username);
    await login.acceptInlineRegisterPolicies();
    await login.submitInlineRegister();
  }
  await new BasePage(page).dismissModals();
}

/** The bearer token the app itself sends: memory-only, so it is re-read after every full load. */
const bearerOf = async (request: Request): Promise<string> => {
  // headerValue reads the complete header set; headers() can omit security-related ones.
  const value = (await request.headerValue('authorization')) ?? '';
  return /^Bearer \S+/.test(value) ? value : '';
};

const isAuthedApiRequest = (config: UploadReadableConfig) => async (request: Request) =>
  request.url().startsWith(`${config.baseUrl}/api/`) && (await bearerOf(request)) !== '';

/**
 * Reload and return the token the reloaded app obtained from its session cookie. Retried until
 * the app answers, because after a pod replacement the first reloads can hit a pod that is not
 * serving yet.
 */
async function reloadSignedIn(
  page: Page,
  config: UploadReadableConfig,
  previous: string,
  timeout: number
): Promise<string> {
  let authorization = '';
  await expect(async () => {
    const authed = page.waitForRequest(isAuthedApiRequest(config), { timeout: 30_000 });
    authed.catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    authorization = await bearerOf(await authed);
    // A request the old page fired just before the reload committed would carry the old token.
    // Compared as a boolean so a failure message never prints the token.
    expect(authorization !== previous, 'the request seen was from before the reload').toBe(true);
  }, 'the reloaded app made no signed-in API request; the session did not survive').toPass({ timeout });
  return authorization;
}

async function replaceAppPod(config: UploadReadableConfig): Promise<{ before: AppPod[]; after: AppPod[] }> {
  const kube = config.kube!;
  const before = parseAppPods(await kubectl(appPodsArgs(kube)));
  await kubectl(restartAppArgs(kube));
  await kubectl(rolloutStatusArgs(kube, config.readyTimeoutMs), config.readyTimeoutMs + 30_000);

  let after: AppPod[] = [];
  await expect(async () => {
    after = parseAppPods(await kubectl(appPodsArgs(kube)));
    const verdict = podsWereReplaced(before, after);
    expect(verdict, verdict.ok ? '' : verdict.reason).toEqual({ ok: true });
  }).toPass({ timeout: 120_000, intervals: [3_000] });

  // A `kubectl port-forward` dies with the pod it was bound to; this waits for whatever fronts
  // the app (a restarted forward, an ingress) to answer again.
  await expect(async () => {
    const res = await fetch(`${config.baseUrl}/login`, { signal: AbortSignal.timeout(10_000) });
    expect(res.status).toBeLessThan(500);
  }, `${config.baseUrl} did not answer after the pod replacement; restart the port-forward`).toPass({
    timeout: config.readyTimeoutMs,
    intervals: [3_000],
  });
  return { before, after };
}

test('an uploaded file reads back byte-identical after reload and app pod replacement', async ({ page }, testInfo) => {
  const config = readUploadReadableConfig(process.env);
  test.setTimeout(3 * config.readyTimeoutMs + 15 * 60_000);

  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = buildPayload(nonce);
  // The reference every read is compared with. Under SELFHOST_MUTATE_EXPECTED it is one bit off
  // the uploaded bytes, so every comparison below must fail.
  const reference = config.mutateExpected ? mutateOneBit(payload) : payload;
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfhost-upload-readable-'));
  const uploadPath = path.join(uploadDir, `upload-readable-${nonce}.txt`);
  fs.writeFileSync(uploadPath, payload);

  const receipt: Record<string, unknown> = {
    check: 'selfhost-upload-readable',
    revision: config.revision ?? 'not supplied (set SELFHOST_REVISION)',
    startedAt: new Date().toISOString(),
    mutateExpected: config.mutateExpected,
    uploaded: { bytes: payload.length, sha256: sha256Hex(payload) },
    reads: [],
    podReplacement: config.kube ? 'pending' : 'SKIPPED (SELFHOST_SKIP_POD_REPLACE=true)',
  };
  const reads = receipt.reads as Record<string, unknown>[];
  const expectedReads = config.kube ? 3 : 2;

  const readAndCompare = async (phase: string, authorization: string, fileId: string, timeout: number) => {
    let last: BrowserRead | undefined;
    await expect(async () => {
      last = await readInBrowser(page, fileId, authorization);
      // A thrown fetch is the browser refusing the request before any status exists.
      const hint =
        last.stage === 'threw'
          ? ' (is the object store at S3_PRESIGN_ENDPOINT reachable from this machine, and does it allow cross-origin reads from the app origin?)'
          : '';
      expect(
        last.stage,
        `${phase}: the browser could not read the file: ${JSON.stringify(last).slice(0, 300)}${hint}`
      ).toBe('read');
    }).toPass({ timeout, intervals: [3_000] });
    const read = last as Extract<BrowserRead, { stage: 'read' }>;
    const actual = Buffer.from(read.base64, 'base64');
    const verdict = compareBytes(reference, actual);
    reads.push({ phase, at: new Date().toISOString(), readSha256: sha256Hex(actual), ...verdict });
    // Soft under mutation so the run goes on to show the comparison failing at all three reads.
    (config.mutateExpected ? expect.soft : expect)(
      verdict,
      `${phase}: ${verdict.ok ? '' : verdict.reason}${config.mutateExpected ? ' (expected: SELFHOST_MUTATE_EXPECTED is set)' : ''}`
    ).toMatchObject({ ok: true });
    return read;
  };

  try {
    await test.step('sign in through the login form', () => signIn(page, config));

    const { fileId, authorization } = await test.step('upload through the composer', async () => {
      await new NavigationPage(page).navigateToNewChat();
      const created = page.waitForResponse(
        res => res.url().includes('/api/files/createFabFile') && res.request().method() === 'POST',
        { timeout: TIMEOUTS.ACTION }
      );
      created.catch(() => {});
      // Self-host sends the bytes to the same-origin upload proxy (pages/api/files/[id]/upload.ts).
      const stored = page.waitForResponse(
        res =>
          /\/api\/files\/[a-f0-9]{24}\/upload$/.test(new URL(res.url()).pathname) && res.request().method() === 'PUT',
        { timeout: TIMEOUTS.ACTION }
      );
      stored.catch(() => {});
      await new FileUploadPage(page).uploadFile(uploadPath);

      const response = await created;
      expect(response.ok(), `createFabFile answered ${response.status()}`).toBe(true);
      const body = (await response.json()) as { id?: string; _id?: string };
      const id = body.id ?? body._id;
      expect(id, 'createFabFile returned no id').toBeTruthy();
      expect((await stored).ok(), 'the upload proxy refused the bytes').toBe(true);
      const token = await bearerOf(response.request());
      expect(token !== '', 'the upload request carried no bearer token').toBe(true);
      return { fileId: id!, authorization: token };
    });
    receipt.fileId = fileId;
    let latest = authorization;

    // Longer wait here only: the file is withheld until the upload scan marks it clean.
    const first = await test.step('read 1: straight after the upload', () =>
      readAndCompare('after upload', authorization, fileId, 5 * 60_000));

    await test.step('a wrong-key read fails', async () => {
      const outcome = await fetchInBrowser(page, wrongKeyUrl(first.fileUrl, nonce));
      receipt.wrongKeyRead = { status: outcome.status, failed: !outcome.ok };
      // The right key on this same origin just read fine, so a refusal here is about the key.
      expect(outcome.ok, `the store served a re-pointed signed URL (HTTP ${outcome.status})`).toBe(false);
    });

    await test.step('a missing-object read fails', async () => {
      expect(first.filePath, 'the file record carried no storage key').toBeTruthy();
      const missingKey = `${first.filePath}.missing-${nonce}`;

      // The app must not hand out a URL at all. It declines because the key has no FabFile record
      // (filterServeableFilePaths in pages/api/files/presigned-url.ts), not by probing the store.
      const signing = await fetchInBrowser(
        page,
        `/api/files/presigned-url?${new URLSearchParams({ 'filePaths[]': missingKey }).toString()}`,
        authorization
      );
      // A 2xx with an explicit null is the app declining this key; an error status would pass for
      // the wrong reason (an expired token, say), so it is not accepted.
      expect(signing.ok, `presigned-url answered HTTP ${signing.status}`).toBe(true);
      const { urls } = JSON.parse(('body' in signing && signing.body) || '{}') as { urls?: unknown[] };
      expect(urls, 'the app signed a URL for a key that has no object').toEqual([null]);

      // And the store itself must not serve that key, asked for it directly.
      const direct = new URL(first.fileUrl);
      direct.pathname = `${direct.pathname}.missing-${nonce}`;
      direct.search = '';
      const outcome = await fetchInBrowser(page, direct.toString());
      receipt.missingObjectRead = { signingStatus: signing.status, storeStatus: outcome.status, failed: !outcome.ok };
      expect(outcome.ok, `the store served a missing object (HTTP ${outcome.status})`).toBe(false);
    });

    await test.step('read 2: after a reload', async () => {
      latest = await reloadSignedIn(page, config, latest, 2 * 60_000);
      await readAndCompare('after reload', latest, fileId, 60_000);
    });

    if (config.kube) {
      await test.step('read 3: after the app pod is replaced', async () => {
        const { before, after } = await replaceAppPod(config);
        receipt.podReplacement = { before, after };
        latest = await reloadSignedIn(page, config, latest, config.readyTimeoutMs);
        await readAndCompare('after pod replacement', latest, fileId, 2 * 60_000);
      });
    }
  } finally {
    fs.rmSync(uploadDir, { recursive: true, force: true });
    receipt.finishedAt = new Date().toISOString();
    if (config.mutateExpected) {
      // A mutation run also fails when sign-in or the upload breaks; only this field says the
      // comparison itself rejected every read.
      receipt.mutationDetectedAtEveryRead = reads.length === expectedReads && reads.every(read => read.ok === false);
    }
    const body = JSON.stringify(receipt, null, 2);
    await testInfo.attach('selfhost-upload-readable-receipt.json', { body, contentType: 'application/json' });
    console.log(body);
  }

  expect(reads.length, 'not every read ran').toBe(expectedReads);
});
