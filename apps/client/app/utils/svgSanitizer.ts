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
  // SMIL animation tags (animate/animateTransform/animateMotion/set) are deliberately
  // NOT allowed: they can rewrite an <a href> to javascript: at runtime.
];

const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'srcset', 'background', 'poster', 'action', 'formaction']);

// Every CSS construct that can make the browser fetch something.
const CSS_FETCH = /(?:-webkit-image-set|image-set|url)\s*\(([^)]*)\)?|@import/gi;

const decodeCssEscapes = (css: string): string =>
  css.replace(/\\([0-9a-f]{1,6})\s?|\\([\s\S])/gi, (_match, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? '';
    const codePoint = parseInt(hex, 16);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '�';
  });

const isInDocumentOrInline = (target: string): boolean => /^['"]?\s*(?:#|data:)/i.test(target.trim());

/** True when CSS text would fetch anything other than an in-document (#id) or data: resource. */
export function cssHasRemoteReference(css: string): boolean {
  for (const match of decodeCssEscapes(css).matchAll(CSS_FETCH)) {
    if (match[0].startsWith('@') || !isInDocumentOrInline(match[1] ?? '')) return true;
  }
  return false;
}

const isAllowedUrl = (value: string, tagName: string): boolean => {
  const url = value.trim();
  if (url.startsWith('#')) return true;
  // A link only navigates when clicked; everything else would load on render.
  if (tagName === 'a') return /^(?:https?|mailto):/i.test(url);
  return /^data:image\/(?:png|gif|jpe?g|webp)[;,]/i.test(url);
};

/**
 * Removes every reference that would make the browser load a resource from outside the
 * document: remote image/use/link targets, url()/@import in style attributes, presentation
 * attributes and <style> blocks. Mutates `root` in place.
 */
export function stripRemoteSvgReferences(root: Element | DocumentFragment): void {
  const elements = root instanceof Element ? [root, ...root.querySelectorAll('*')] : [...root.querySelectorAll('*')];
  for (const element of elements) {
    const tagName = element.localName.toLowerCase();
    if (tagName === 'style') {
      if (cssHasRemoteReference(element.textContent ?? '')) element.remove();
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

/**
 * mermaid.initialize options that keep diagram labels and directives from adding resource
 * loads. mermaid mounts its output into the page to measure it before render() returns, so
 * this has to apply inside mermaid, ahead of stripRemoteSvgReferences on the result.
 * `secure` replaces mermaid's default list, so the defaults are repeated here.
 */
export const MERMAID_RESOURCE_CONFIG = {
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'maxTextSize',
    'suppressErrorRendering',
    'maxEdges',
    'dompurifyConfig',
    'themeCSS',
    'themeVariables',
    'fontFamily',
  ],
  dompurifyConfig: {
    FORBID_TAGS: ['img', 'image', 'picture', 'source', 'video', 'audio', 'style', 'link', 'object', 'embed', 'iframe'],
    FORBID_ATTR: ['style', 'src', 'srcset', 'background', 'poster'],
  },
};

/** Throws when a diagram definition would make the rendered SVG fetch an external resource. */
export function assertNoRemoteDiagramResources(definition: string): void {
  if (cssHasRemoteReference(definition)) {
    throw new Error('Diagrams cannot load external images or stylesheets');
  }
}
