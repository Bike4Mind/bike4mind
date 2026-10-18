import { readFile, stat } from 'node:fs/promises';
import { fleetOrigin } from './FleetClient';

/**
 * The connection Fleet's installer writes to `~/.claude/fleet/bike4mind-desktop.json`.
 *
 * Must stay in sync with Fleet's `scripts/otel/install.sh` (write_desktop_conf): version 1,
 * the Fleet origin, the shared team telemetry key, the person's email and the install id.
 */
export interface FleetConfig {
  endpoint: string;
  key: string;
  email: string | null;
  installId: string;
}

export type FleetConfigResult =
  { kind: 'connected' | 'no-email'; config: FleetConfig } | { kind: 'not-installed' | 'insecure' | 'invalid' };

const KEY_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const INSTALL_ID_RE = /^[0-9a-f]{32}$/;
const EMAIL_RE = /^[^\s@:]+@[^\s@:]+$/;

/** Parse the file's contents. Pure. */
export function parseFleetConfig(raw: string): FleetConfigResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'invalid' };
  const doc = value as Record<string, unknown>;
  if (doc.version !== 1) return { kind: 'invalid' };
  const endpoint = typeof doc.endpoint === 'string' ? fleetOrigin(doc.endpoint) : null;
  if (!endpoint || endpoint !== doc.endpoint) return { kind: 'invalid' };
  if (typeof doc.key !== 'string' || !KEY_RE.test(doc.key)) return { kind: 'invalid' };
  if (typeof doc.installId !== 'string' || !INSTALL_ID_RE.test(doc.installId)) return { kind: 'invalid' };
  const rawEmail = typeof doc.email === 'string' ? doc.email.trim().toLowerCase() : '';
  const email = rawEmail && rawEmail.length <= 254 && EMAIL_RE.test(rawEmail) ? rawEmail : null;
  const config: FleetConfig = { endpoint, key: doc.key, email, installId: doc.installId };
  return { kind: email ? 'connected' : 'no-email', config };
}

export interface FleetConfigFs {
  stat(path: string): Promise<{ mode: number; isFile(): boolean }>;
  readFile(path: string): Promise<string>;
}

const nodeFs: FleetConfigFs = { stat: path => stat(path), readFile: path => readFile(path, 'utf8') };

/**
 * Read the installer file. It holds the team key, so a copy other users can read is ignored
 * rather than used; Windows has no POSIX mode bits to check.
 */
export async function readFleetConfig(
  path: string,
  fs: FleetConfigFs = nodeFs,
  platform: NodeJS.Platform = process.platform
): Promise<FleetConfigResult> {
  let info: { mode: number; isFile(): boolean };
  try {
    info = await fs.stat(path);
  } catch {
    return { kind: 'not-installed' };
  }
  if (!info.isFile()) return { kind: 'invalid' };
  if (platform !== 'win32' && (info.mode & 0o077) !== 0) return { kind: 'insecure' };
  try {
    return parseFleetConfig(await fs.readFile(path));
  } catch {
    return { kind: 'invalid' };
  }
}
