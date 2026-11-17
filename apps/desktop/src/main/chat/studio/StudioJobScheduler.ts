export class StudioJobScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private scope: string | null = null;
  private readonly due = new Map<string, { at: number; delay: number }>();
  constructor(
    private readonly deps: {
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
        const workspace = session.studioWorkspaceId
          ? { workspaceId: session.studioWorkspaceId }
          : await this.deps.workspace(session.id, scope);
        if (!workspace || visited.has(workspace.workspaceId)) continue;
        visited.add(workspace.workspaceId);
        const previous = this.due.get(workspace.workspaceId);
        if (previous && previous.at > Date.now()) continue;
        let delay = 5000;
        try {
          await this.deps.recover(session.id);
          if (!this.stopped && scope === this.deps.scope()) this.deps.changed(session.id, workspace.workspaceId);
          delay = Math.min((previous?.delay ?? 2500) * 2, 60_000);
        } catch {
          delay = Math.min((previous?.delay ?? 5000) * 2, 300_000);
        }
        if (scope !== this.deps.scope()) return;
        this.due.set(workspace.workspaceId, { at: Date.now() + delay, delay });
      }
      for (const id of this.due.keys()) if (!visited.has(id)) this.due.delete(id);
    } catch {
      // A damaged workspace must not stop recovery of the remaining runtime.
    } finally {
      if (!this.stopped) this.schedule(5000);
    }
  }
}
