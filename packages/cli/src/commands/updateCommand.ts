/**
 * External update command (b4m update)
 * Checks for and installs CLI updates.
 * Runs outside the interactive CLI session.
 */

import { execSync, spawnSync } from 'child_process';
import { createInterface } from 'readline';
import packageJson from '../../package.json';
import {
  forceCheckForUpdate,
  checkForUpdate,
  isNpmPrefixWritable,
  getAutoUpdatePreference,
  setAutoUpdatePreference,
  shouldAttemptAutoUpdate,
  INSTALL_CMD,
  REEXEC_GUARD_ENV,
} from '../utils/updateChecker.js';
import { checkRipgrep } from '../utils/ripgrepCheck.js';

function runGlobalInstall(): boolean {
  try {
    execSync(INSTALL_CMD, { stdio: 'inherit', timeout: 120_000 });
    return true;
  } catch {
    console.error('\nInstall failed. Try running manually:');
    console.error(`  ${INSTALL_CMD}`);
    console.error('\nIf you get permission errors, try:');
    console.error(`  sudo ${INSTALL_CMD}`);
    return false;
  }
}

/** The user's answer to the on-launch update prompt. */
export type UpdateChoice = 'update' | 'always' | 'skip' | 'never';

/**
 * Ask the user how to handle an available update (the `'ask'` preference).
 * Plain readline (not Ink) because this runs in the bin bootstrap before the
 * code-split app loads - the only window in which it's safe to install.
 *
 * Maps the [U/a/s/n] keys to a choice; an empty line defaults to `'update'`
 * (capital `U` in the prompt is the default). The interface is fully torn down
 * before returning so a Skip/Never fall-through leaves stdin clean for Ink.
 */
export async function promptUpdateChoice(currentVersion: string, latestVersion: string): Promise<UpdateChoice> {
  // Defense-in-depth: never prompt against a non-interactive stdin. The launch
  // gate already requires an interactive stdin, but if we somehow reach here
  // without one, skip rather than block launch or read garbage off a pipe.
  if (!process.stdin.isTTY) return 'skip';

  console.log(`\n\x1b[33m  ⬆ Update available: v${currentVersion} → v${latestVersion}\x1b[0m\n`);
  console.log('  How would you like to handle updates?');
  console.log('    [U] Update once   (install now)');
  console.log('    [A] Always        (auto-update silently from now on)');
  console.log('    [S] Skip          (not now — ask again next launch)');
  console.log('    [N] Never         (manual `b4m update` only)\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Resolve null on 'close' (EOF / Ctrl-D) so the promise ALWAYS settles - a
  // never-firing question callback would hang launch indefinitely - and so EOF
  // maps to skip, never to the 'update' default. We must never auto-install on
  // a closed stdin.
  let answer: string | null;
  try {
    answer = await new Promise<string | null>(resolve => {
      rl.on('close', () => resolve(null));
      rl.question('  Choose [U/a/s/n]: ', resolve);
    });
  } finally {
    rl.close();
  }
  if (answer === null) return 'skip'; // EOF / Ctrl-D — decline without installing

  switch (answer.trim().toLowerCase()) {
    case 'a':
      return 'always';
    case 's':
      return 'skip';
    case 'n':
      return 'never';
    default:
      return 'update'; // 'u' or empty (the capitalised default)
  }
}

/**
 * Install the latest version and re-exec into it so the session the user just
 * opened runs the new code - zero version skew, no mid-session file-swap risk.
 *
 * spawnSync inherits the TTY so Ink renders normally in the child; the guard
 * env prevents an update loop. npm install overwrites the global package in
 * place, so re-running the same argv[1] bin path picks up the new code. On a
 * successful spawn this never returns (it calls process.exit); it only returns
 * when the install itself fails, so the caller falls through to the current
 * version.
 */
function installAndReexec(currentVersion: string, latestVersion: string): void {
  console.log(`\x1b[33m  ⬆ Updating v${currentVersion} → v${latestVersion}…\x1b[0m`);
  if (!runGlobalInstall()) return; // install failed — runGlobalInstall already logged guidance

  const child = spawnSync(process.argv[0], process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [REEXEC_GUARD_ENV]: '1' },
  });
  if (child.error) {
    // Couldn't even launch the updated binary - surface it instead of a silent exit 0.
    console.error(`\n  Failed to launch the updated version: ${child.error.message}`);
    console.error('  Re-run b4m to use the newly installed version.');
    process.exit(1);
  }
  // Preserve the child's exit status; map a signal-kill (status === null) to non-zero.
  process.exit(child.status ?? (child.signal ? 1 : 0));
}

/**
 * Auto-update on launch (Claude-Code-style), consent-first.
 *
 * Called from the bin bootstrap on the interactive path *before* the
 * code-split app (`dist/index.mjs`) is imported - the only safe install window
 * (running an install while dist chunks are loaded would crash them).
 *
 * Behaviour by `autoUpdate` preference once an update is available on a
 * writable prefix:
 * - `'auto'`  -> install silently and re-exec into the new version.
 * - `'never'` -> do nothing (the startup notify banner still informs).
 * - `'ask'`   -> prompt the user: Update once / Always (persist `auto`) /
 *               Skip (ask again next launch) / Never (persist `never`).
 *
 * It is a safe no-op (returns without installing) when: already re-exec'd this
 * launch, disabled via `B4M_AUTO_UPDATE=0`, not attached to a TTY, no update is
 * available, the prefix needs sudo (notify banner informs instead), or the
 * user declines the prompt. Any install/network failure is swallowed so the
 * user is never blocked from launching the current version.
 */
export async function maybeAutoUpdateOnLaunch(): Promise<void> {
  // Require BOTH stdin and stdout to be interactive: the 'ask' prompt reads
  // stdin, and a non-interactive launch (piped/redirected) must skip silently.
  // Checking only stdout would let `b4m < /dev/null` reach the prompt and
  // either hang or install without real consent.
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!shouldAttemptAutoUpdate({ isTTY: isInteractive })) return; // env / TTY / re-exec guards

  const preference = await getAutoUpdatePreference();
  if (preference === 'never') return; // opted out — notify banner informs instead

  const currentVersion = packageJson.version;

  // Bounded check so a slow/hung network can never stall launch (mirrors the
  // 3s race the startup banner uses in index.tsx). checkForUpdate is cached, so
  // the common case resolves instantly without touching the network at all.
  // On timeout the losing checkForUpdate promise is intentionally left dangling
  // - it's internally try/catch'd (can't reject) and its eventual cache write is
  // beneficial; don't "clean up" by awaiting it, that would reintroduce the stall.
  let result;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      checkForUpdate(currentVersion),
      new Promise<null>(resolve => {
        timeoutHandle = setTimeout(() => resolve(null), 3000);
      }),
    ]);
  } catch {
    return;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  if (!result?.updateAvailable) return;

  // Can't install to a root-owned prefix without sudo; leave it to the
  // startup notify banner ("run: b4m update") rather than failing silently.
  // Checked before prompting so we never ask about an install we can't perform.
  if (!(await isNpmPrefixWritable())) return;

  if (preference === 'ask') {
    const choice = await promptUpdateChoice(currentVersion, result.latestVersion);
    if (choice === 'skip') return; // not now — ask again next launch (persist nothing)
    if (choice === 'never') {
      await setAutoUpdatePreference(false);
      return;
    }
    if (choice === 'always') await setAutoUpdatePreference(true);
    // 'update' or 'always' fall through to install
  }

  installAndReexec(currentVersion, result.latestVersion);
}

export async function handleUpdateCommand(): Promise<void> {
  const currentVersion = packageJson.version;

  console.log(`Current version: v${currentVersion}`);
  console.log('Checking for updates...\n');

  const result = await forceCheckForUpdate(currentVersion);

  if (!result) {
    console.error('Failed to check for updates. Check your internet connection.');
    process.exit(1);
  }

  const rgBefore = await checkRipgrep();
  const needsRepair = !rgBefore.available;

  if (!result.updateAvailable && !needsRepair) {
    console.log(`Already on the latest version (v${currentVersion}).`);
    return;
  }

  if (result.updateAvailable) {
    console.log(`Update available: v${currentVersion} → v${result.latestVersion}`);
  }
  if (needsRepair) {
    console.log(`Repairing missing ripgrep binary (${rgBefore.error ?? 'unknown reason'})`);
  }
  console.log('\nInstalling...\n');

  if (!runGlobalInstall()) {
    process.exit(1);
  }

  const rgAfter = await checkRipgrep();
  if (!rgAfter.available) {
    console.error('\nWarning: ripgrep is still unavailable after install.');
    console.error(`  ${rgAfter.error ?? 'unknown reason'}`);
    console.error('The grep_search tool will not work. Try a forced reinstall:');
    console.error(`  ${INSTALL_CMD} --force`);
    process.exit(1);
  }

  if (result.updateAvailable) {
    console.log(`\nSuccessfully updated to v${result.latestVersion}.`);
  } else {
    console.log('\nRipgrep restored.');
  }
}
