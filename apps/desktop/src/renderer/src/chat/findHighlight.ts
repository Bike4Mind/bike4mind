/**
 * Painting find matches with the CSS Custom Highlight API: ranges are registered by name and
 * styled with `::highlight(name)`, so nothing is wrapped in the React-owned DOM and a re-render
 * cannot leave a stale `<mark>` behind or lose one.
 *
 * Only text inside a `data-find-scope` element is searched, and each text node belongs to its
 * NEAREST scope, so a reply round's scope does not also count the tool rows drawn inside it.
 */

export const FIND_HIGHLIGHT = 'chat-find';
export const FIND_CURRENT_HIGHLIGHT = 'chat-find-current';

const SCOPE_ATTRIBUTE = 'data-find-scope';

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

/** The registry and constructor, or null where the API is missing (a test DOM). */
function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

/**
 * The query's occurrences in one scope element's own text, as ranges. Matched over the text of
 * all its nodes joined, so a match that spans markup (a word half in bold) is still one range.
 */
export function scopeRanges(scope: Element, pattern: RegExp): Range[] {
  const document = scope.ownerDocument;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: node =>
      node.parentElement?.closest(`[${SCOPE_ATTRIBUTE}]`) === scope
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let joined = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    nodes.push(text);
    starts.push(joined.length);
    joined += text.data;
  }

  // The node holding offset `at`; an end offset sits at the end of the node before it.
  const locate = (at: number, end: boolean): [Text, number] => {
    let index = 0;
    while (index + 1 < nodes.length && (end ? starts[index + 1]! < at : starts[index + 1]! <= at)) index++;
    return [nodes[index]!, at - starts[index]!];
  };

  const ranges: Range[] = [];
  pattern.lastIndex = 0;
  for (let found = pattern.exec(joined); found; found = pattern.exec(joined)) {
    const range = document.createRange();
    range.setStart(...locate(found.index, false));
    range.setEnd(...locate(found.index + found[0].length, true));
    ranges.push(range);
  }
  return ranges;
}

/**
 * Every match drawn under `root`, and the current one by its scope and occurrence. Returns the
 * current range, or null when that scope is not drawn (yet). The occurrence is clamped: a reply's
 * data can hold markdown syntax its drawing does not, so a scope can draw fewer than it counts.
 */
export function paintMatches(
  root: Element,
  pattern: RegExp,
  current: { scope: string; occurrence: number } | null
): Range | null {
  const all: Range[] = [];
  let currentRange: Range | null = null;
  for (const element of root.querySelectorAll(`[${SCOPE_ATTRIBUTE}]`)) {
    const ranges = scopeRanges(element, pattern);
    all.push(...ranges);
    if (current && element.getAttribute(SCOPE_ATTRIBUTE) === current.scope && ranges.length > 0) {
      currentRange = ranges[Math.min(current.occurrence, ranges.length - 1)]!;
    }
  }

  const api = highlightApi();
  if (api) {
    api.registry.set(FIND_HIGHLIGHT, new api.Highlight(...all));
    if (currentRange) api.registry.set(FIND_CURRENT_HIGHLIGHT, new api.Highlight(currentRange));
    else api.registry.delete(FIND_CURRENT_HIGHLIGHT);
  }
  return currentRange;
}

export function clearMatches() {
  const api = highlightApi();
  api?.registry.delete(FIND_HIGHLIGHT);
  api?.registry.delete(FIND_CURRENT_HIGHLIGHT);
}

/** Brings a range to the middle of the scrolling host, unless it is already well inside it. */
export function scrollRangeIntoView(host: HTMLElement, range: Range) {
  if (typeof range.getBoundingClientRect !== 'function') return;
  const rect = range.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const margin = Math.min(80, host.clientHeight / 4);
  if (rect.top >= hostRect.top + margin && rect.bottom <= hostRect.bottom - margin) return;
  host.scrollTop += rect.top - hostRect.top - host.clientHeight / 2 + rect.height / 2;
}
