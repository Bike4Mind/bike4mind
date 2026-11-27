import { copyFile, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PreferenceFile } from '../../preferenceFile';
import { isValidSshAlias } from './sshCommand';

export const SSH_HOSTS_FILE_NAME = 'hosts.json';

/**
 * One remote machine Desktop connects to over SSH. `id` is Desktop's key for it (the `hostId` of
 * the ConnectionManager, the host bridge and HostEntry) and never changes. `reportedHostId` is the
 * id the host program itself reports in `host/initialize`, known after the first connection: two
 * aliases that reach the same reportedHostId are one host with two routes.
 */
export const sshHostRecordSchema = z.object({
  id: z.string().min(1),
  reportedHostId: z.string().min(1).nullable(),
  /** The ssh aliases that reach this host, tried in order. */
  aliases: z.array(z.string().refine(isValidSshAlias)),
  /** False after the user disconnects the host, until they connect it again. */
  enabled: z.boolean(),
  /** When a connection last reached the host, in ms since the epoch. */
  lastSeenAt: z.number().nullable(),
  /** The user agreed to install and update the host program on this machine. */
  installConsent: z.boolean(),
});
export type SshHostRecord = z.infer<typeof sshHostRecordSchema>;

export type SshHostsFileContents = { version: 1; hosts: SshHostRecord[] };

const fileShape = z.object({ version: z.literal(1), hosts: z.array(z.unknown()) });

/**
 * Accepts anything, as a PreferenceFile parse must: a missing or unreadable file is an empty list,
 * and a record that does not parse (a hand edit, an alias that is no longer valid) is dropped on
 * its own instead of costing the rest.
 */
export function parseSshHostsFile(value: unknown): SshHostsFileContents {
  const parsed = fileShape.safeParse(value);
  if (!parsed.success) return { version: 1, hosts: [] };
  const ids = new Set<string>();
  const hosts: SshHostRecord[] = [];
  for (const raw of parsed.data.hosts) {
    const record = sshHostRecordSchema.safeParse(raw);
    if (!record.success || ids.has(record.data.id)) continue;
    ids.add(record.data.id);
    hosts.push(record.data);
  }
  return { version: 1, hosts };
}

/** Suffix of the copy kept of a `hosts.json` this build cannot read, before anything overwrites it. */
export const UNREADABLE_COPY_SUFFIX = '.unreadable';

/**
 * Keeps a copy of a file that exists but does not parse (a hand edit gone wrong, or a newer
 * build's version), because the first save after loading it as empty would replace it.
 */
async function preserveUnreadable(path: string, log: (message: string) => void): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (fileShape.safeParse(raw).success) return;
  await copyFile(path, `${path}${UNREADABLE_COPY_SUFFIX}`);
  log(
    `HOST: ${path} could not be read; kept a copy at ${path}${UNREADABLE_COPY_SUFFIX} and started an empty host list`
  );
}

export type SshHostStore = {
  load(): Promise<SshHostsFileContents>;
  update(patch: Partial<SshHostsFileContents>): Promise<SshHostsFileContents>;
};

/** `hosts.json` in userData: the remote hosts Desktop knows, written atomically and owner-only. */
export function sshHostsFile(path: string, log: (message: string) => void): SshHostStore {
  const file = new PreferenceFile(path, parseSshHostsFile, 'SSH hosts');
  return {
    load: async () => {
      await preserveUnreadable(path, log);
      return file.load();
    },
    update: patch => file.update(patch),
  };
}
