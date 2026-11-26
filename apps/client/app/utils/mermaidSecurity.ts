import type { MermaidConfig } from 'mermaid';
import { cssHasCrossOriginReference } from './svgSanitizer';

/**
 * mermaid.initialize options that keep diagram labels and directives from adding resource
 * loads. mermaid mounts its output into the page to measure it before render() returns, so
 * this has to apply inside mermaid, ahead of stripRemoteSvgReferences on the result.
 * `secure` replaces mermaid's default list, so the defaults are repeated here. themeVariables and
 * fontFamily stay unlocked: assertNoRemoteDiagramResources scans the init directive for
 * cross-origin url(), and themeCSS stays locked.
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
  ],
  dompurifyConfig: {
    FORBID_TAGS: ['img', 'image', 'picture', 'source', 'video', 'audio', 'style', 'link', 'object', 'embed', 'iframe'],
    FORBID_ATTR: ['style', 'src', 'srcset', 'background', 'poster'],
  },
} satisfies MermaidConfig;

/**
 * The one option set every inline mermaid renderer initializes the shared mermaid singleton
 * with, so the result never depends on which component mounted last.
 */
export const mermaidOptions = (isDark: boolean): MermaidConfig => ({
  startOnLoad: false,
  theme: isDark ? 'dark' : 'default',
  // 'strict' sanitizes labels and disables click-handler/javascript: link injection.
  // PNG export serializes the inline <svg> that render() returns, which 'strict' leaves
  // in place - only 'sandbox' (iframe-wrapped output) would break it.
  securityLevel: 'strict',
  // Without this, a parse failure draws mermaid's error diagram into the temporary container
  // it appends to <body> and throws before its own cleanup runs.
  suppressErrorRendering: true,
  ...MERMAID_RESOURCE_CONFIG,
});

const HEX_ESCAPE = /\\(?:x[\da-f]{2}|u[\da-f]{4}|U[\da-f]{8})/;
const IMG_WORD = /\bimg\b/gi;
const INLINE_IMG_VALUE = /^img\s*["']?\s*:\s*["']?\s*data:image\//i;

/**
 * Shape data (`A@{ img: "..." }`) is YAML, and mermaid loads an `img` value with `new Image()`
 * while it lays the diagram out. Rather than parse YAML, everything after the first `@{` must
 * name `img` only as a key with a data: image value; a hex escape there could spell the key, so
 * it is refused too.
 */
function hasExternalShapeImage(definition: string): boolean {
  const start = definition.indexOf('@{');
  if (start < 0) return false;
  const shapeText = definition.slice(start);
  if (HEX_ESCAPE.test(shapeText)) return true;
  for (const match of shapeText.matchAll(IMG_WORD)) {
    if (!INLINE_IMG_VALUE.test(shapeText.slice(match.index))) return true;
  }
  return false;
}

/** Throws when rendering a diagram definition would fetch a resource from another origin. */
export function assertNoRemoteDiagramResources(definition: string): void {
  // @import is not checked: diagram CSS only lands inside a rule body (classDef, style), where it
  // is inert, and themeCSS is locked by MERMAID_RESOURCE_CONFIG.
  if (cssHasCrossOriginReference(definition) || hasExternalShapeImage(definition)) {
    throw new Error('Diagrams cannot load external images or stylesheets');
  }
}
