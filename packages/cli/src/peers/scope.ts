import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PeerIdentity } from './protocol.js';

const execFileAsync = promisify(execFile);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function peerAccountId(endpoint: string, userId: string): string {
  return digest(JSON.stringify([endpoint, userId]));
}

export function peerAccountScope(
  config: { userId: string; auth?: { userId: string } },
  endpoint: string,
  signedOutLocal: boolean
): { endpoint: string; userId: string } {
  return signedOutLocal
    ? { endpoint: 'local-only', userId: config.userId }
    : { endpoint, userId: config.auth?.userId ?? config.userId };
}

export async function createPeerIdentity(input: {
  cwd: string;
  endpoint: string;
  userId: string;
  threadId: string;
  name?: string;
  grantedDirectories?: string[];
}): Promise<PeerIdentity> {
  const cwd = await realpath(input.cwd);
  let project = cwd;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], { cwd, timeout: 2000 });
    project = await realpath(resolve(cwd, stdout.trim()));
  } catch {
    // Non-Git folders are scoped to their canonical directory.
  }
  const name = input.name?.trim() || 'CLI';
  const unsafeName = Array.from(name).some(character => {
    const code = character.codePointAt(0)!;
    return (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
  if (name.length > 100 || unsafeName) throw new Error('Peer names must be at most 100 printable characters.');
  return {
    id: randomUUID(),
    generation: randomUUID(),
    threadId: input.threadId,
    name,
    projectId: digest(
      JSON.stringify([
        project,
        [...new Set(await Promise.all((input.grantedDirectories ?? []).map(dir => realpath(dir))))].sort(),
      ])
    ),
    accountId: peerAccountId(input.endpoint, input.userId),
  };
}
