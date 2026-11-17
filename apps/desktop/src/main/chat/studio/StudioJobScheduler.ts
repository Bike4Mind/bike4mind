import type { StudioDiagnosticSink } from './StudioDiagnostics';

export class StudioJobScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private scope: string | null = null;
  private readonly due = new Map<string, { at: number; delay: number }>();
  constructor(
    private readonly deps: {
      diagnostic?: StudioDiagnosticSink;
      scope(): string | null;
      sessions(): Promise<readonly { id: string; studioWorkspaceId?: string }[]>;
      workspace(sessionId: string, scope: string): Promise<{ workspaceId: string } | null>;
      recover(sessionId: string): Promise<unknown>;
      changed(sessionId: string, workspaceId: string): void;
    }
  ) {}

  start(): void {
    if (!this.timer && !this.stopped) this.schedule(0);
  }
  dispose(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.due.clear();
  }
  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const scope = this.deps.scope();
    if (scope !== this.scope) {
      this.scope = scope;
      this.due.clear();
    }
    try {
      if (!scope) return;
      const visited = new Set<string>();
      for (const session of await this.deps.sessions()) {
        if (this.stopped || scope !== this.deps.scope()) return;
        let workspaceId: string | undefined;
        let phase: 'scheduler-workspace' | 'scheduler-recovery' = 'scheduler-workspace';
        try {
          const workspace = session.studioWorkspaceId
            ? { workspaceId: session.studioWorkspaceId }
            : await this.deps.workspace(session.id, scope);
          if (this.stopped || scope !== this.deps.scope()) return;
          if (!workspace || visited.has(workspace.workspaceId)) continue;
          workspaceId = workspace.workspaceId;
          visited.add(workspaceId);
          const previous = this.due.get(workspaceId);
          if (previous && previous.at > Date.now()) continue;
          phase = 'scheduler-recovery';
          await this.deps.recover(session.id);
          if (this.stopped || scope !== this.deps.scope()) return;
          this.deps.changed(session.id, workspaceId);
          const delay = Math.min((previous?.delay ?? 2500) * 2, 60_000);
          this.due.set(workspaceId, { at: Date.now() + delay, delay });
        } catch {
          if (this.stopped || scope !== this.deps.scope()) return;
          this.deps.diagnostic?.(phase, { sessionId: session.id, ...(workspaceId ? { workspaceId } : {}) });
          if (workspaceId) {
            const delay = Math.min((this.due.get(workspaceId)?.delay ?? 5000) * 2, 300_000);
            this.due.set(workspaceId, { at: Date.now() + delay, delay });
          }
        }
      }
      for (const id of this.due.keys()) if (!visited.has(id)) this.due.delete(id);
    } catch {
      if (!this.stopped && scope === this.deps.scope()) this.deps.diagnostic?.('scheduler-enumeration', {});
    } finally {
      if (!this.stopped) this.schedule(5000);
    }
  }
}
