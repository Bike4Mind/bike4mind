import type { VaultFile } from '../auth/tokenVault';

export interface FleetSettingsLogger {
  warn(message: string): void;
}

/**
 * The sharing switch, in one file under userData. The Fleet connection itself comes from the
 * installer's file, so nothing secret is stored here. A file from an older build that also held
 * a URL or a key is rewritten without them on the next change.
 */
export class FleetSettingsStore {
  private consent: boolean | null = null;

  constructor(
    private readonly file: VaultFile,
    private readonly logger: FleetSettingsLogger
  ) {}

  async read(): Promise<{ consent: boolean }> {
    if (this.consent === null) {
      this.consent = false;
      try {
        const raw = await this.file.read();
        const parsed = raw ? (JSON.parse(raw) as { consent?: unknown }) : null;
        this.consent = parsed?.consent === true;
      } catch {
        this.logger.warn('FLEET: settings file unreadable, starting with sharing off');
      }
    }
    return { consent: this.consent };
  }

  async setConsent(consent: boolean): Promise<void> {
    this.consent = consent;
    try {
      await this.file.write(JSON.stringify({ version: 2, consent }, null, 2));
    } catch (err) {
      this.logger.warn(`FLEET: failed to write settings: ${err instanceof Error ? err.name : 'unknown'}`);
    }
  }
}
