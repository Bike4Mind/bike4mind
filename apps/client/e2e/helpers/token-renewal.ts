import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { APIRequestContext } from '@playwright/test';
import { apiLoginViaOtc } from './api';
import { AUTH_DIR, getTestUsers, saveCoreData, saveSpecUser, type TestUser } from './test-users';

/**
 * Mid-run renewal of the access tokens the setup projects saved.
 *
 * An access token lasts 30 minutes (ACCESS_TOKEN_TTL_SECONDS in server/auth/tokenGenerator.ts) and
 * each one is minted once, at setup, so a project that starts late or runs long would otherwise
 * reach 401 responses and /login redirects. fixtures.ts calls renewExpiringTokens when a worker
 * starts and before every test.
 */

// Renew once less than this is left. A spec that reads a token in beforeAll keeps that copy for the
// rest of the file, so this must stay above the slowest spec file's run time.
const RENEW_WHEN_REMAINING_MS = 12 * 60 * 1000;
// A sign-in can wait most of a TOTP step for the account's next unused code.
const LOCK_STALE_MS = 90 * 1000;
const LOCK_WAIT_MS = 30 * 1000;

interface RenewTarget {
  /** Users saved in the same file share a lock, since saving one rewrites the whole file. */
  lock: string;
  read: () => TestUser | undefined;
  write: (user: TestUser) => void;
}

function expiresSoon(accessToken: string): boolean {
  try {
    const payload: unknown = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf-8'));
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === 'number' && exp * 1000 - Date.now() < RENEW_WHEN_REMAINING_MS;
  } catch {
    return false;
  }
}

/**
 * Run `fn` holding a lock file that every worker process sees. Returns false if the wait ran out.
 * The file holds the owner's id so a slow holder never deletes a lock another worker has since
 * taken, and a stale lock is renamed away and, if it turns out to be a live one, put back.
 */
export async function withLock(name: string, fn: () => Promise<void>): Promise<boolean> {
  const lockPath = path.resolve(AUTH_DIR, `${name}.renew.lock`);
  const owner = crypto.randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, owner, { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const heldSince = fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs;
      if (heldSince !== undefined && Date.now() - heldSince > LOCK_STALE_MS) {
        const aside = `${lockPath}.${owner}.stale`;
        try {
          const staleOwner = fs.readFileSync(lockPath, 'utf-8');
          fs.renameSync(lockPath, aside);
          // The lock may have been replaced between the stat and the rename: put a live one back.
          if (fs.readFileSync(aside, 'utf-8') !== staleOwner) fs.linkSync(aside, lockPath);
          fs.rmSync(aside, { force: true });
        } catch {
          // Another worker broke or released it first; loop and try to take it.
        }
      } else if (Date.now() > deadline) {
        return false;
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }
  try {
    await fn();
  } finally {
    try {
      if (fs.readFileSync(lockPath, 'utf-8') === owner) fs.rmSync(lockPath, { force: true });
    } catch {
      // Already gone: a worker broke it as stale.
    }
  }
  return true;
}

// playwright.config project names are kebab-case (data-lake); spec-user keys are camelCase (dataLake).
export function projectNameToSpecKey(projectName: string): string {
  return projectName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** The core admin and manager, plus the project's own users (skills -> skills, skillsMember). */
function targetsForProject(projectName: string): RenewTarget[] {
  const specKey = projectNameToSpecKey(projectName);
  const { specUsers } = getTestUsers();
  const core = (role: 'admin' | 'manager'): RenewTarget => ({
    lock: 'core',
    read: () => getTestUsers()[role],
    write: user => {
      const { admin, manager, inviteCode } = getTestUsers();
      saveCoreData({ admin, manager, inviteCode, [role]: user });
    },
  });
  const spec = (key: string): RenewTarget => ({
    lock: key,
    read: () => getTestUsers().specUsers[key],
    write: user => saveSpecUser(key, user),
  });
  return [
    core('admin'),
    core('manager'),
    ...Object.keys(specUsers)
      .filter(key => key.startsWith(specKey))
      .map(spec),
  ];
}

/**
 * Sign in again, through OTC, every user of `projectName` whose saved access token is close to
 * expiry, and save the new tokens over the old ones. A new sign-in leaves the earlier session
 * valid, so tests already running on the old token are not disturbed.
 *
 * Best effort: a user that cannot be signed in (a spec deleted it or changed its email) keeps its
 * old token and the failure is logged, so the test that needs the token reports the real problem.
 */
export async function renewExpiringTokens(
  newRequestContext: () => Promise<APIRequestContext>,
  projectName: string
): Promise<void> {
  let targets: RenewTarget[];
  try {
    targets = targetsForProject(projectName);
  } catch {
    // Core data does not exist yet: nothing has been minted.
    return;
  }
  const stale = targets.filter(target => {
    const user = target.read();
    return !!user && expiresSoon(user.accessToken);
  });
  if (stale.length === 0) return;

  const request = await newRequestContext();
  try {
    for (const target of stale) {
      try {
        const locked = await withLock(target.lock, async () => {
          // Another worker may have renewed it while this one waited for the lock.
          const user = target.read();
          if (!user || !expiresSoon(user.accessToken)) return;
          const tokens = await apiLoginViaOtc(request, user.email);
          target.write({ ...user, ...tokens });
          console.log(`[token-renewal] renewed a ${target.lock} token for project ${projectName}`);
        });
        if (!locked) console.warn(`[token-renewal] gave up waiting for the ${target.lock} lock`);
      } catch (err) {
        console.warn(`[token-renewal] could not renew a ${target.lock} token: ${String(err)}`);
      }
    }
  } finally {
    await request.dispose();
  }
}
