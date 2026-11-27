/**
 * Finding file paths in a reply, so they can be drawn as links.
 *
 * Detection only picks candidates; nothing here decides that a path is real. Main checks each one
 * against the session's shared folders (filePathLinks.ts), and only a path that exists there is
 * drawn as a link, which is why the patterns can afford to be generous ("and/or" is a candidate
 * that simply never resolves).
 */

/** One path component. A leading dot is allowed for `.github` and `.env`. */
const SEGMENT = String.raw`\.?[A-Za-z0-9_@+][A-Za-z0-9_.@+-]*`;
const LINE = String.raw`(?::\d+(?::\d+)?)?`;

const WINDOWS = String.raw`[A-Za-z]:\\(?:${SEGMENT}\\)*${SEGMENT}\\?`;
const ROOTED = String.raw`(?:~|\.{1,2})?/(?:${SEGMENT}/)*${SEGMENT}/?`;
const RELATIVE = String.raw`(?:${SEGMENT}/)+${SEGMENT}/?`;
const PATH = String.raw`(?:${WINDOWS}|${ROOTED}|${RELATIVE})${LINE}`;
/** A lone file name, linked only when it is a whole inline code span: `package.json`. */
const BARE = String.raw`${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,15}${LINE}`;

// The lookbehind keeps a path from starting mid-word or mid-url (`http://host/a` never yields `/a`).
const IN_TEXT = new RegExp(String.raw`(?<![\w.~/\\:@-])${PATH}(?![\w/\\@])`, 'g');
const WHOLE_CODE = new RegExp(String.raw`^(?:${PATH}|${BARE})$`);

/** Dates and fractions (11/17/2026, 1/2) read as paths and never are. */
const ALL_NUMERIC = /^[\d/\\:.]+$/;

const MAX_LENGTH = 1024;

function usable(candidate: string): boolean {
  return candidate.length <= MAX_LENGTH && !ALL_NUMERIC.test(candidate) && !candidate.includes('://');
}

export type PathSegment = { kind: 'text'; text: string } | { kind: 'path'; text: string };

/** `text` split into prose and the paths in it. A sentence's closing dot is left out of the path. */
export function splitFilePaths(text: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(IN_TEXT)) {
    const start = match.index;
    const path = match[0].replace(/\.+$/, '');
    if (!usable(path) || path.length === 0) continue;
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) });
    segments.push({ kind: 'path', text: path });
    last = start + path.length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}

/** The path an inline code span names when the span is nothing but a path, else null. */
export function inlineCodePath(code: string): string | null {
  const trimmed = code.trim();
  return WHOLE_CODE.test(trimmed) && usable(trimmed) ? trimmed : null;
}

/**
 * The parts of a hast node this step reads and writes. Declared here rather than imported from
 * `hast`, which this package does not depend on directly; a real hast tree satisfies it.
 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** The `data-file-path` attribute the renderer's `span` component looks for. */
export const FILE_PATH_PROPERTY = 'dataFilePath';

const marker = (path: string, children: HastNode[]): HastNode => ({
  type: 'element',
  tagName: 'span',
  properties: { [FILE_PATH_PROPERTY]: path },
  children,
});

/** Inline code's text, when it is a single text node. */
function codeText(node: HastNode): string | null {
  const [only, ...rest] = node.children ?? [];
  return only?.type === 'text' && rest.length === 0 && typeof only.value === 'string' ? only.value : null;
}

function walk(node: HastNode): void {
  if (!node.children) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && child.value) {
      for (const segment of splitFilePaths(child.value)) {
        const text: HastNode = { type: 'text', value: segment.text };
        next.push(segment.kind === 'path' ? marker(segment.text, [text]) : text);
      }
      continue;
    }
    if (child.type === 'element') {
      // A link already goes somewhere, and a fenced block is code rather than prose.
      if (child.tagName === 'a' || child.tagName === 'pre') {
        next.push(child);
        continue;
      }
      if (child.tagName === 'code') {
        const text = codeText(child);
        const path = text === null ? null : inlineCodePath(text);
        // The code node itself is kept, position and all: ReplyMarkdown reads that to tell inline from fenced.
        next.push(path ? marker(path, [child]) : child);
        continue;
      }
      walk(child);
    }
    next.push(child);
  }
  node.children = next;
}

/**
 * A rehype step that wraps each candidate path in a `span` carrying `data-file-path`.
 *
 * It must run AFTER rehype-sanitize, which would strip the attribute; that is safe because it adds
 * no markup the reply wrote, only a wrapper around text the sanitizer already passed.
 */
export function rehypeFilePaths() {
  return (tree: HastNode) => walk(tree);
}
