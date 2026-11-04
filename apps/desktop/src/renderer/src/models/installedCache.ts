import type { LocalModelEntry } from '@shared/models';
import type { ModelServerView } from '@shared/modelServers';

export interface LastInstalled {
  models: LocalModelEntry[];
  /** Epoch ms of the listing. */
  listedAt: number;
}

/** The listing's time, with its date when it was not listed today. */
export function listedAtLabel(at: number, now: number = Date.now()): string {
  const listed = new Date(at);
  const time = listed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (listed.toDateString() === new Date(now).toDateString()) return time;
  return `${listed.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** What a cached list belongs to: a server whose address or kind changed is another server. */
export function serverIdentity(server: Pick<ModelServerView, 'transport' | 'address' | 'kind'>): string {
  return `${server.transport} ${server.kind} ${server.address}`;
}

/**
 * Each server's last successful Installed listing, so switching to it shows that list while it is listed again.
 * Kept for this run only: the next launch lists every server afresh anyway.
 */
export class InstalledCache {
  readonly #entries = new Map<string, LastInstalled & { identity: string }>();

  get(serverId: string, identity: string | null): LastInstalled | null {
    const entry = this.#entries.get(serverId);
    if (!entry || identity === null || entry.identity !== identity) return null;
    return { models: entry.models, listedAt: entry.listedAt };
  }

  set(serverId: string, identity: string, models: LocalModelEntry[], listedAt: number): void {
    this.#entries.set(serverId, { identity, models, listedAt });
  }

  readonly #cuts = new Map<string, number>();

  /**
   * Listings of the server started before now are not cached. A removal calls it before and after it runs, since a
   * listing started in between may have been answered before the delete.
   */
  cutListings(serverId: string): void {
    this.#cuts.set(serverId, this.cuts(serverId) + 1);
  }

  /** Counts cutListings calls for a server; a listing that started at another count is not cached. */
  cuts(serverId: string): number {
    return this.#cuts.get(serverId) ?? 0;
  }

  /** A model removed through the app leaves that server's cached list too. */
  dropModel(serverId: string, name: string): void {
    const entry = this.#entries.get(serverId);
    if (entry) this.#entries.set(serverId, { ...entry, models: entry.models.filter(model => model.name !== name) });
  }

  /** Drops entries for servers no longer saved, or saved under the same id with another address or kind. */
  retain(servers: readonly ModelServerView[]): void {
    const current = new Map(servers.map(server => [server.id, serverIdentity(server)]));
    for (const [id, entry] of this.#entries) {
      if (current.get(id) !== entry.identity) this.#entries.delete(id);
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#cuts.clear();
  }
}

export const installedCache = new InstalledCache();
