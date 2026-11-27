import { randomUUID } from 'node:crypto';
import type { HostConnectionStatus, HostEntry, SshAliasEntry } from '@shared/hostConnection';
import { HostConnectError, hostMethods, type HostConnectFailure, type HostTransport } from '@shared/hostProtocol';
import type { ConnectionManager, HostConnector, HostUserAction } from '../ConnectionManager';
import type { SshConfigListing } from './sshConfig';
import type { SshHostRecord, SshHostStore } from './sshHostsFile';

export type SshHostDirectoryOptions = {
  manager: Pick<ConnectionManager, 'register' | 'unregister' | 'connect' | 'relabel' | 'onStateChanged'>;
  store: SshHostStore;
  /** Opens a protocol connection through one alias: in Desktop, ssh running `b4m-host connect`. */
  openTransport(alias: string): Promise<HostTransport>;
  /** The aliases of `~/.ssh/config`; only these can be added. */
  listConfigHosts(): Promise<SshConfigListing>;
  /**
   * Runs before each connection through `alias` and may refuse it by rejecting, as the connector
   * would (in Desktop, HostProvisioner.beforeConnect).
   */
  prepareConnection?(id: string, alias: string): Promise<void>;
  now?: () => number;
  newId?: () => string;
  log?: (message: string) => void;
};

/** States in which a connection reached the host program. */
const SEEN_STATUSES: ReadonlySet<HostConnectionStatus> = new Set(['connected', 'needsSignIn', 'accountMismatch']);
/** How stale the saved lastSeenAt of a reachable host may get before it is written again, in ms. */
const LAST_SEEN_WRITE_INTERVAL_MS = 10 * 60 * 1000;

const lostWith = (detail: string): HostConnectFailure => ({ kind: 'lost', detail, stderrTail: '' });

const labelOf = (record: SshHostRecord): string => record.aliases[0] ?? record.id;

/** The host's own id from a `host/initialize` result, or null for a result out of shape (the handshake reports that). */
function reportedHostIdOf(result: unknown): string | null {
  const parsed = hostMethods['host/initialize'].result.safeParse(result);
  return parsed.success ? parsed.data.hostId : null;
}

/**
 * The remote hosts Desktop reaches over SSH: their saved records (`hosts.json`), their
 * registration with the ConnectionManager, and the connector each one connects through.
 *
 * Each connection's `host/initialize` answer is checked against the record before the link may
 * use it. The first answer records the host's own id; an alias whose host turns out to be one
 * already known joins that host as a second route; and an alias that now reaches another machine
 * than before is moved to that machine's record. Either way the connection that found out is
 * refused, so a host's sessions are never served under another host's key.
 */
export class SshHostDirectory {
  private records: SshHostRecord[] = [];
  /** Per host: which of its aliases the next attempt starts from. */
  private readonly nextRoute = new Map<string, number>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (message: string) => void;
  private unsubscribe: () => void = () => undefined;

  constructor(private readonly options: SshHostDirectoryOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `ssh-${randomUUID()}`);
    this.log = options.log ?? (() => undefined);
  }

  /** Reads `hosts.json` and registers every host in it; an enabled one starts connecting. */
  async load(): Promise<void> {
    this.records = (await this.options.store.load()).hosts;
    for (const record of this.records) this.register(record);
    this.unsubscribe = this.options.manager.onStateChanged(entries => this.observe(entries));
  }

  dispose(): void {
    this.unsubscribe();
  }

  list(): SshHostRecord[] {
    return this.records.map(record => ({ ...record, aliases: [...record.aliases] }));
  }

  /** The aliases of `~/.ssh/config`, each with the host it is a route to, if any. */
  async aliasEntries(): Promise<SshAliasEntry[]> {
    const { aliases, problems } = await this.options.listConfigHosts();
    for (const problem of problems) this.log(`HOST: ~/.ssh/config: ${problem}`);
    return aliases.map(alias => ({
      alias,
      hostId: this.records.find(record => record.aliases.includes(alias))?.id ?? null,
    }));
  }

  /**
   * Adds the host an alias from `~/.ssh/config` reaches, enabled, and starts connecting to it.
   * Returns the existing record when the alias is already a route of a known host.
   */
  async add(alias: string): Promise<SshHostRecord> {
    const { aliases } = await this.options.listConfigHosts();
    if (!aliases.includes(alias)) throw new Error(`${alias} is not a host in ~/.ssh/config`);
    const known = this.records.find(record => record.aliases.includes(alias));
    if (known) {
      if (!known.enabled) this.options.manager.connect(known.id);
      return { ...known };
    }
    const record: SshHostRecord = {
      id: this.newId(),
      reportedHostId: null,
      aliases: [alias],
      enabled: true,
      lastSeenAt: null,
      installConsent: false,
    };
    // Registered before the save is awaited, so a second add of the alias meanwhile finds a live host.
    this.records.push(record);
    this.register(record);
    await this.save();
    return { ...record };
  }

  /**
   * The alias the host's next connection goes through, and whether the user agreed to installs
   * on it; null for a host that is not saved or has no alias left.
   */
  installTarget(id: string): { alias: string; installConsent: boolean } | null {
    const record = this.records.find(candidate => candidate.id === id);
    if (!record || record.aliases.length === 0) return null;
    const index = (this.nextRoute.get(id) ?? 0) % record.aliases.length;
    return { alias: record.aliases[index], installConsent: record.installConsent };
  }

  /** Records whether the user agreed to install and update the host program on this host. */
  async setInstallConsent(id: string, consent: boolean): Promise<void> {
    this.require(id).installConsent = consent;
    await this.save();
  }

  private register(record: SshHostRecord): void {
    this.options.manager.register(record.id, this.connectorFor(record.id), {
      label: labelOf(record),
      kind: 'remote',
      connect: record.enabled,
      lastSeenAt: record.lastSeenAt,
      onUserAction: action => void this.userAction(record.id, action),
    });
  }

  private connectorFor(id: string): HostConnector {
    return {
      connect: async () => {
        const record = this.records.find(candidate => candidate.id === id);
        if (!record || record.aliases.length === 0) {
          throw new HostConnectError(lostWith('No SSH alias in ~/.ssh/config reaches this host any more'));
        }
        const index = (this.nextRoute.get(id) ?? 0) % record.aliases.length;
        const alias = record.aliases[index];
        const advance = () => this.nextRoute.set(id, index + 1);
        let transport: HostTransport;
        try {
          await this.options.prepareConnection?.(id, alias);
          transport = await this.options.openTransport(alias);
        } catch (error) {
          advance();
          throw error;
        }
        return this.checkedTransport(id, alias, transport, advance);
      },
    };
  }

  /**
   * The transport as the link sees it: unchanged, except that the `host/initialize` answer must
   * come from the host this record names. A connection that ends before that answer moves the
   * next attempt on to the host's next alias.
   */
  private checkedTransport(id: string, alias: string, transport: HostTransport, advance: () => void): HostTransport {
    let initialized = false;
    const detach = transport.onClose(reason => {
      if (!initialized && reason.initiator === 'host') advance();
    });
    return {
      request: async (method, params) => {
        const result = await transport.request(method, params);
        if (method !== 'host/initialize') return result;
        const reportedHostId = reportedHostIdOf(result);
        const refusal = reportedHostId === null ? null : this.identify(id, alias, reportedHostId);
        if (refusal) {
          detach();
          transport.close();
          throw new HostConnectError(refusal);
        }
        initialized = true;
        detach();
        return result;
      },
      onNotification: listener => transport.onNotification(listener),
      onClose: listener => transport.onClose(listener),
      close: () => transport.close(),
    };
  }

  /**
   * Matches a connection's reported host id against the record; returns why it is refused, or
   * null to accept it. Synchronous on purpose: records and registrations change together, before
   * anything else (a remove, another handshake) can run in between; the save follows on its own.
   */
  private identify(id: string, alias: string, reportedHostId: string): HostConnectFailure | null {
    const record = this.records.find(candidate => candidate.id === id);
    if (!record) return lostWith('This host was removed');
    if (record.reportedHostId === reportedHostId) return null;
    const owner = this.records.find(candidate => candidate.reportedHostId === reportedHostId);

    if (record.reportedHostId === null && !owner) {
      record.reportedHostId = reportedHostId;
      void this.save();
      return null;
    }
    if (record.reportedHostId === null && owner) {
      this.log(`HOST ${id}: ${alias} reaches host ${owner.id}; merging it in as another route`);
      this.mergeInto(owner, record);
      void this.save();
      return lostWith(`${alias} reaches a host that is already known; it was added as another way to reach it`);
    }

    this.log(`HOST ${id}: ${alias} now reaches another machine (${reportedHostId}); moving it there`);
    record.aliases = record.aliases.filter(candidate => candidate !== alias);
    this.nextRoute.delete(id);
    let target = owner;
    if (target) {
      if (!target.aliases.includes(alias)) target.aliases.push(alias);
    } else {
      target = {
        id: this.newId(),
        reportedHostId,
        aliases: [alias],
        enabled: record.enabled,
        lastSeenAt: null,
        installConsent: false,
      };
      this.records.push(target);
      this.register(target);
    }
    // A host with no alias left cannot be reached at all; most often its machine was reinstalled
    // and now reports a new id, so what the user chose for it carries over to that machine.
    if (record.aliases.length === 0) {
      target.enabled = target.enabled || record.enabled;
      target.installConsent = target.installConsent || record.installConsent;
      this.forget(record.id);
    } else {
      this.relabel(record);
    }
    this.relabel(target);
    if (target.enabled) this.options.manager.connect(target.id);
    void this.save();
    return lostWith(`${alias} now reaches a different machine than before`);
  }

  /** Folds `merged` into `owner` as more routes, and forgets `merged`. */
  private mergeInto(owner: SshHostRecord, merged: SshHostRecord): void {
    for (const alias of merged.aliases) if (!owner.aliases.includes(alias)) owner.aliases.push(alias);
    owner.enabled = owner.enabled || merged.enabled;
    owner.installConsent = owner.installConsent || merged.installConsent;
    owner.lastSeenAt = Math.max(owner.lastSeenAt ?? 0, merged.lastSeenAt ?? 0) || null;
    this.forget(merged.id);
    this.relabel(owner);
    if (owner.enabled) this.options.manager.connect(owner.id);
  }

  /** Drops a record and its registration; the save is the caller's. */
  private forget(id: string): void {
    this.records = this.records.filter(candidate => candidate.id !== id);
    this.nextRoute.delete(id);
    this.options.manager.unregister(id);
  }

  private relabel(record: SshHostRecord): void {
    this.options.manager.relabel(record.id, labelOf(record));
  }

  private async userAction(id: string, action: HostUserAction): Promise<void> {
    if (action === 'remove') {
      this.records = this.records.filter(record => record.id !== id);
      this.nextRoute.delete(id);
    } else {
      const record = this.records.find(candidate => candidate.id === id);
      if (!record) return;
      record.enabled = action === 'connect';
    }
    await this.save();
  }

  private observe(entries: HostEntry[]): void {
    const now = this.now();
    let changed = false;
    for (const entry of entries) {
      if (!SEEN_STATUSES.has(entry.state.status)) continue;
      const record = this.records.find(candidate => candidate.id === entry.hostId);
      if (!record || (record.lastSeenAt !== null && now - record.lastSeenAt < LAST_SEEN_WRITE_INTERVAL_MS)) continue;
      record.lastSeenAt = now;
      changed = true;
    }
    if (changed) void this.save();
  }

  private require(id: string): SshHostRecord {
    const record = this.records.find(candidate => candidate.id === id);
    if (!record) throw new Error(`No SSH host ${id}`);
    return record;
  }

  private async save(): Promise<void> {
    await this.options.store.update({ version: 1, hosts: this.list() });
  }
}
