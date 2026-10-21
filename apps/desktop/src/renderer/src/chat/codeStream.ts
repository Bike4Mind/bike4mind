/**
 * Code still being written, hidden from a reply's text.
 *
 * Nobody reads a file as it streams in word by word, and an artifact's body is ordinary reply
 * text until main extracts it when the reply settles - so without this, a dashboard component
 * scrolls past as raw source for a minute before turning into a card. The status line names
 * what is being written instead (see describeActivity).
 */
export type PendingCode = ({ kind: 'artifact'; title?: string } | { kind: 'code'; language?: string }) & {
  /**
   * The hidden source itself, so the status line can disclose what it is naming. Tail-bounded
   * HERE rather than where it is shown: a file streams in over hundreds of kilobytes and this
   * runs on every frame of the stream, whether or not anyone has the disclosure open.
   */
  body: string;
};

const PENDING_BODY_CHARS = 2000;

/** The end of what has arrived so far, never more than one disclosure can use. */
function tailFrom(text: string, index: number): string {
  return text.slice(Math.max(index, text.length - PENDING_BODY_CHARS));
}

export interface PresentedReply {
  text: string;
  /** Code still arriving at the end of the text. Only ever set while streaming. */
  pending: PendingCode | null;
  /**
   * A settled reply that stopped inside an artifact - almost always the length limit. Its title,
   * or '' when it had none. Main only extracts a closed tag, so the body would otherwise be
   * left in the text as raw source.
   */
  unfinishedArtifact: string | null;
}

const CLOSED_ARTIFACT = /<artifact\b[^>]*>[\s\S]*?<\/artifact\s*>/gi;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`)
    .exec(tag)
    ?.slice(1)
    .find(value => value !== undefined);
}

/** Where the last still-open fence starts, and its language, or null when every fence is closed. */
function openFence(text: string): { index: number; language?: string } | null {
  let open: { index: number; marker: string; language?: string } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const match = FENCE_OPEN.exec(line);
    if (match) {
      const [, marker, info] = match;
      if (!open) {
        open = { index: offset, marker, ...(info ? { language: info } : {}) };
      } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && !info) {
        open = null;
      }
    }
    offset += line.length + 1;
  }
  return open && { index: open.index, ...(open.language ? { language: open.language } : {}) };
}

export function presentReply(text: string, streaming: boolean): PresentedReply {
  let visible = text.replace(CLOSED_ARTIFACT, '');

  const start = visible.search(/<artifact\b/i);
  if (start !== -1) {
    const tagEnd = visible.indexOf('>', start);
    const title = attribute(visible.slice(start, tagEnd === -1 ? undefined : tagEnd + 1), 'title');
    const body = tailFrom(visible, start);
    visible = visible.slice(0, start).trimEnd();
    return streaming
      ? { text: visible, pending: { kind: 'artifact', ...(title ? { title } : {}), body }, unfinishedArtifact: null }
      : { text: visible, pending: null, unfinishedArtifact: title ?? '' };
  }

  if (!streaming) return { text: visible, pending: null, unfinishedArtifact: null };

  // The tag itself arrives a few characters at a time; "<arti" must not flash up first.
  const partialTag = /<[a-z]*$/i.exec(visible);
  if (partialTag && '<artifact'.startsWith(partialTag[0].toLowerCase())) {
    visible = visible.slice(0, partialTag.index);
  }

  const fence = openFence(visible);
  if (fence) {
    return {
      text: visible.slice(0, fence.index).trimEnd(),
      pending: {
        kind: 'code',
        ...(fence.language ? { language: fence.language } : {}),
        body: tailFrom(visible, fence.index),
      },
      unfinishedArtifact: null,
    };
  }
  return { text: visible, pending: null, unfinishedArtifact: null };
}

/** The status-line wording for code being written; see describeActivity. */
export function pendingCodePhrase(pending: PendingCode): string {
  if (pending.kind === 'artifact')
    return pending.title ? `Creating an artifact: ${pending.title}...` : 'Creating an artifact...';
  return 'Writing code...';
}
