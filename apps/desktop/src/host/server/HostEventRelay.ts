import type { HostEventSink } from '../ports';

export type HostEventSource = {
  /** Every push the runtime makes reaches `sink` until the returned function is called. */
  subscribe(sink: HostEventSink): () => void;
};

/**
 * Lets protocol servers watch a runtime's pushes without becoming its one sink. The runtime is
 * built with `tee(primary)`: the primary sink (Desktop's renderer IPC) sees each push first, so
 * a listener that throws can neither reorder nor stop it.
 */
export class HostEventRelay implements HostEventSource {
  private readonly sinks = new Set<HostEventSink>();

  constructor(private readonly reportError: (error: unknown) => void) {}

  subscribe(sink: HostEventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  tee(primary: HostEventSink): HostEventSink {
    return {
      streamEvent: event => {
        primary.streamEvent(event);
        this.forEach(sink => sink.streamEvent(event));
      },
      sessionSummary: summary => {
        primary.sessionSummary(summary);
        this.forEach(sink => sink.sessionSummary(summary));
      },
      sessionStatus: (event, statusChanged) => {
        primary.sessionStatus(event, statusChanged);
        this.forEach(sink => sink.sessionStatus(event, statusChanged));
      },
      queueChanged: event => {
        primary.queueChanged(event);
        this.forEach(sink => sink.queueChanged(event));
      },
      taskDecisions: decisions => {
        primary.taskDecisions(decisions);
        this.forEach(sink => sink.taskDecisions(decisions));
      },
      loopChanged: (sessionId, state) => {
        primary.loopChanged(sessionId, state);
        this.forEach(sink => sink.loopChanged(sessionId, state));
      },
    };
  }

  private forEach(push: (sink: HostEventSink) => void): void {
    for (const sink of this.sinks) {
      try {
        push(sink);
      } catch (error) {
        this.reportError(error);
      }
    }
  }
}
