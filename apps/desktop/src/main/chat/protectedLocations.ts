import { join } from 'node:path';
import { spellingsOf } from './tools/paths';

const warned = new Set<string>();

/**
 * Folders that stay protected, each under its given, real and own spellings. Resolved on use and
 * retried on each later use until it resolves; only a resolution is kept.
 */
export class ProtectedLocations {
  private readonly resolved = new Map<string, readonly string[]>();
  private settled: readonly string[] | null = null;
  private pending: readonly string[] = [];

  constructor(
    private readonly locations: readonly string[],
    private readonly logger: { warn(message: string): void }
  ) {}

  /** Every spelling known so far; an unresolved location contributes the spellings it has. */
  paths(): readonly string[] {
    if (this.settled) return this.settled;
    const all: string[] = [];
    const pending: string[] = [];
    for (const location of this.locations) {
      let spellings = this.resolved.get(location);
      if (!spellings) {
        const { known, resolved } = spellingsOf(location);
        spellings = known;
        if (resolved) {
          this.resolved.set(location, known);
        } else {
          pending.push(location);
          if (!warned.has(location)) {
            warned.add(location);
            this.logger.warn(`PROTECTED: cannot resolve ${location}; writes are refused until it resolves`);
          }
        }
      }
      all.push(...spellings);
    }
    const paths = [...new Set(all)];
    this.pending = pending;
    if (pending.length === 0) this.settled = paths;
    return paths;
  }

  /** The locations still unresolved after a fresh attempt. Once empty, `paths` is fixed. */
  unresolved(): readonly string[] {
    this.paths();
    return this.pending;
  }
}

/** Folders no allow rule may cover. */
export function permissionProtectedLocations(
  userData: string,
  home: string,
  managedSettingsDir: string,
  logger: { warn(message: string): void }
): ProtectedLocations {
  return new ProtectedLocations([userData, join(home, '.claude'), managedSettingsDir], logger);
}

/** Paths no tool may write, share or upload, and a sandboxed shell may not read; userData holds the auth vault. */
export function toolProtectedLocations(userData: string, logger: { warn(message: string): void }): ProtectedLocations {
  return new ProtectedLocations([userData], logger);
}
