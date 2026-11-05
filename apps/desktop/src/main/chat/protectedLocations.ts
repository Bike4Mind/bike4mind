import { join } from 'node:path';
import { withRealPath } from './tools/paths';

/** Folders no allow rule may cover, each under both its given and its real spelling. */
export function permissionProtectedRoots(userData: string, home: string, managedSettingsDir: string): string[] {
  return [userData, join(home, '.claude'), managedSettingsDir].flatMap(withRealPath);
}

/** Paths no tool may write, share or upload, and a sandboxed shell may not read; userData holds the auth vault. */
export function toolProtectedPaths(userData: string): string[] {
  return withRealPath(userData);
}
