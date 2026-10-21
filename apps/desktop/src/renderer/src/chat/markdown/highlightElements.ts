import { createElement, type CSSProperties, type ReactNode } from 'react';
import type { createElementProps, SyntaxHighlighterProps } from 'react-syntax-highlighter';

type Stylesheet = createElementProps['stylesheet'];
type HighlightNode = createElementProps['node'];
export type HighlightRenderer = NonNullable<SyntaxHighlighterProps['renderer']>;

/**
 * A drop-in for react-syntax-highlighter's own `createElement`, which re-derives the theme's
 * whole selector list for EVERY token it draws - an O(selectors^2) scan per span. Measured on a
 * long transcript it was most of the time spent opening it. The output is the same elements;
 * the selector set and each class combination's style are worked out once per theme instead.
 *
 * Both caches are keyed on the stylesheet's identity, which SYNTAX_THEMES keeps stable.
 */
const selectorsByTheme = new WeakMap<Stylesheet, Set<string>>();
const stylesByTheme = new WeakMap<Stylesheet, Map<string, CSSProperties>>();

function selectorsOf(stylesheet: Stylesheet): Set<string> {
  let selectors = selectorsByTheme.get(stylesheet);
  if (!selectors) {
    selectors = new Set(Object.keys(stylesheet).flatMap(selector => selector.split('.')));
    selectorsByTheme.set(stylesheet, selectors);
  }
  return selectors;
}

/** Every ordering of every non-empty subset: the library's lookup order, kept so styles merge the same way. */
function permutations(names: readonly string[]): string[] {
  if (names.length <= 1) return [...names];
  const out: string[] = [];
  const walk = (prefix: string[], rest: readonly string[]) => {
    for (let i = 0; i < rest.length; i++) {
      const next = [...prefix, rest[i]];
      out.push(next.join('.'));
      walk(next, [...rest.slice(0, i), ...rest.slice(i + 1)]);
    }
  };
  walk([], names.slice(0, 4));
  // The library lists all singles, then all pairs, then triples: a later, more specific
  // combination has to win the merge.
  return out.sort((a, b) => a.split('.').length - b.split('.').length);
}

function styleFor(stylesheet: Stylesheet, classNames: readonly string[]): CSSProperties {
  let cache = stylesByTheme.get(stylesheet);
  if (!cache) {
    cache = new Map();
    stylesByTheme.set(stylesheet, cache);
  }
  const key = classNames.join(' ');
  let style = cache.get(key);
  if (!style) {
    style = {};
    for (const name of permutations(classNames.filter(name => name !== 'token'))) {
      Object.assign(style, stylesheet[name]);
    }
    cache.set(key, style);
  }
  return style;
}

export function highlightElement(
  node: HighlightNode,
  stylesheet: Stylesheet,
  useInlineStyles: boolean,
  key: string
): ReactNode {
  if (node.type === 'text') return node.value;
  const tagName = node.tagName;
  if (!tagName) return undefined;

  const properties = node.properties ?? { className: [] };
  const classNames: string[] = properties.className ?? [];
  let props: Record<string, unknown>;
  if (!useInlineStyles) {
    props = { ...properties, className: classNames.join(' ') };
  } else {
    const selectors = selectorsOf(stylesheet);
    const kept = [
      ...(classNames.includes('token') ? ['token'] : []),
      ...classNames.filter(name => !selectors.has(name)),
    ];
    const shared = styleFor(stylesheet, classNames);
    props = {
      ...properties,
      className: kept.join(' ') || undefined,
      style: properties.style ? { ...properties.style, ...shared } : shared,
    };
  }
  const children = (node.children ?? []).map((child, index) =>
    highlightElement(child, stylesheet, useInlineStyles, `${key}-${index}`)
  );
  return createElement(tagName, { key, ...props }, children);
}

/** The highlighter's default rendering of its rows, through highlightElement. */
export const fastRenderer: HighlightRenderer = ({ rows, stylesheet, useInlineStyles }) =>
  rows.map((row, index) => highlightElement(row, stylesheet, useInlineStyles, `code-segment-${index}`));
