import type { ChatArtifact, ChatMessage } from '@shared/chat';

/** One artifact in the open conversation, at its latest version. */
export interface SessionArtifact {
  /** The model's identifier when it gave one, so an update replaces its earlier version here. */
  key: string;
  artifact: ChatArtifact;
  /** ISO time of the message that carried this version. */
  updatedAt: string;
}

/** Every artifact the conversation's replies carry, one row per artifact, most recently updated first. */
export function sessionArtifacts(messages: readonly ChatMessage[]): SessionArtifact[] {
  const latest = new Map<string, SessionArtifact & { order: number }>();
  let order = 0;
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) {
      const key = artifact.identifier || artifact.id;
      latest.delete(key);
      latest.set(key, { key, artifact, updatedAt: message.createdAt, order: order++ });
    }
  }
  return [...latest.values()]
    .sort((a, b) => {
      const byTime = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
      return byTime || b.order - a.order;
    })
    .map(({ key, artifact, updatedAt }) => ({ key, artifact, updatedAt }));
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page the browser pane shows for an artifact. HTML is the page itself and an SVG draws as
 * one; every other type shows as its source, as the transcript card does for types it cannot run.
 */
export function paneDocument(artifact: Pick<ChatArtifact, 'type' | 'content'>): string {
  if (artifact.type === 'html') return artifact.content;
  if (artifact.type === 'svg') return `<!DOCTYPE html><body style="margin:0">${artifact.content}</body>`;
  return (
    '<!DOCTYPE html><body style="margin:0;padding:16px;font:13px/1.5 ui-monospace,Menlo,monospace">' +
    `<pre style="margin:0;white-space:pre-wrap">${escapeHtml(artifact.content)}</pre></body>`
  );
}

/** When the row was last updated: the time today, the date otherwise. */
export function updatedLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
