import DOMPurify from 'dompurify';

const SVG_ARTIFACT_TAGS = [
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'line',
  'rect',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'defs',
  'clipPath',
  'mask',
  'pattern',
  'use',
  'symbol',
  'linearGradient',
  'radialGradient',
  'stop',
  'filter',
  'feOffset',
  'feFlood',
  'feComposite',
  'feColorMatrix',
  'feGaussianBlur',
  'marker',
  'image',
  'title',
  'desc',
  'foreignObject',
  'switch',
  'metadata',
  // SMIL `animate` and `set` are deliberately left out: they can rewrite an <a href> to
  // javascript: at runtime.
];

const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'srcset', 'background', 'poster', 'action', 'formaction']);

// Every CSS construct that can make the browser fetch something. The lookbehind keeps
// identifiers that merely end in "url" (getUrl(), toDataUrl()) out.
const CSS_FETCH = /(?<![\w-])(?:-webkit-image-set|image-set|url)\s*\(([^)]*)\)?|@import/gi;

const CSS_IMPORT_STATEMENT = /@import\b(?:"[^"\n]*"|'[^'\n]*'|\([^)]*\)|[^;{}"'(])*;?/gi;

const decodeCssEscapes = (css: string): string =>
  css.replace(/\\([0-9a-f]{1,6})\s?|\\([\s\S])/gi, (_match, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? '';
    const codePoint = parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\uFFFD';
  });

const unquote = (target: string): string => target.trim().replace(/^['"]/, '');

const isInDocumentOrInline = (target: string): boolean => /^(?:#|data:)/i.test(unquote(target));

/**
 * True for a URL that leaves the current origin. The URL parser drops tab and newline and reads
 * a leading backslash as a slash, so both are normalised before the check.
 */
export const isCrossOriginUrl = (value: string): boolean => {
  const url = unquote(value).replace(/[\t\n\r]/g, '');
  return /^[\\/]{2}/.test(url) || (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^data:/i.test(url));
};

/** True when CSS text would fetch anything other than an in-document (#id) or data: resource. */
export function cssHasRemoteReference(css: string): boolean {
  for (const match of decodeCssEscapes(css).matchAll(CSS_FETCH)) {
    if (match[0].startsWith('@') || !isInDocumentOrInline(match[1] ?? '')) return true;
  }
  return false;
}

/** True when CSS text has a url()/image-set() pointing at another origin. */
export function cssHasCrossOriginReference(css: string): boolean {
  for (const match of decodeCssEscapes(css).matchAll(CSS_FETCH)) {
    if (!match[0].startsWith('@') && isCrossOriginUrl(match[1] ?? '')) return true;
  }
  return false;
}

// Drops @import statements and turns remote url()/image-set() values into `none`, leaving the
// other rules. Matches on the raw text, so an escaped spelling is left for the caller's re-scan.
const stripRemoteCss = (css: string): string =>
  css
    .replace(CSS_IMPORT_STATEMENT, '')
    .replace(CSS_FETCH, (match, target: string | undefined) => (isInDocumentOrInline(target ?? '') ? match : 'none'));

const isAllowedUrl = (value: string, tagName: string): boolean => {
  const url = value.trim();
  if (url.startsWith('#')) return true;
  // The https/mailto link branch only matters if this sanitizer is reused for inline SVG:
  // in image mode links never navigate.
  if (tagName === 'a') return /^(?:https?|mailto):/i.test(url);
  return /^data:image\/(?:png|gif|jpe?g|webp)[;,]/i.test(url);
};

/**
 * Removes every reference that would make the browser load a resource from outside the
 * document: remote image/use/link targets, and url()/@import in style attributes, presentation
 * attributes and <style> blocks. A <style> block keeps its other rules, and is removed only when a
 * remote reference survives the rewrite. Mutates `root` in place.
 */
export function stripRemoteSvgReferences(root: Element | DocumentFragment): void {
  const elements = root instanceof Element ? [root, ...root.querySelectorAll('*')] : [...root.querySelectorAll('*')];
  for (const element of elements) {
    const tagName = element.localName.toLowerCase();
    if (tagName === 'style') {
      const css = element.textContent ?? '';
      if (cssHasRemoteReference(css)) {
        const stripped = stripRemoteCss(css);
        if (cssHasRemoteReference(stripped)) element.remove();
        else element.textContent = stripped;
      }
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const remote =
        URL_ATTRIBUTES.has(name) || name.endsWith(':href')
          ? !isAllowedUrl(attribute.value, tagName)
          : cssHasRemoteReference(attribute.value);
      if (remote) element.removeAttribute(attribute.name);
    }
  }
}

/** Sanitizes SVG artifact markup into a standalone SVG document string, or '' if none survives. */
export function sanitizeArtifactSvg(raw: string): string {
  const fragment = DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: SVG_ARTIFACT_TAGS,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_DOM_FRAGMENT: true,
  });
  stripRemoteSvgReferences(fragment);
  const svg = fragment.querySelector('svg');
  return svg ? new XMLSerializer().serializeToString(svg) : '';
}

export interface SvgImageSource {
  src: string;
  /** False when the root has no absolute width, so the image should fill its container like inline SVG does. */
  hasIntrinsicWidth: boolean;
}

/**
 * Sanitized SVG as a data: URL for an <img>. Image-mode SVG never loads external resources
 * or runs script, and its <style> rules cannot reach the host page.
 */
export function toSvgImageSource(raw: string): SvgImageSource | null {
  const markup = sanitizeArtifactSvg(raw);
  if (!markup) return null;
  const rootTag = markup.slice(0, markup.indexOf('>') + 1);
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
    hasIntrinsicWidth: /\swidth="\s*[\d.]+(?:px)?\s*"/i.test(rootTag),
  };
}
