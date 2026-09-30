import type { MermaidConfig } from 'mermaid';

/**
 * Turning a mermaid source into an SVG string, so it can be shown down the same `<img>` path
 * as a plain SVG artifact - see the comment on SvgArtifact in ArtifactCard for why that path
 * is the one worth having. Nothing here puts mermaid's output into the document.
 */

/** Why a diagram is not going to be a picture, in the terms the card explains it to the user. */
export type MermaidFailure = 'invalid' | 'html-labels';

export type MermaidResult = { ok: true; svg: string } | { ok: false; reason: MermaidFailure };

export const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  // Nothing here executes script - the output is only ever loaded as an image - but mermaid's
  // default is the safe one and dropping it would quietly matter to anyone who later inlines
  // the SVG. 'strict' also sanitizes labels and refuses click handlers and javascript: links.
  securityLevel: 'strict',
  // On a parse error mermaid otherwise injects its own "Syntax error" graphic into the
  // document. This renderer's document is the transcript; a model's typo must not paint into
  // it. The throw is the signal we want, and it is the only one we want.
  suppressErrorRendering: true,
  // NOT a style preference. Mermaid's default is to wrap label text in <foreignObject>, which
  // is HTML inside the SVG - and foreignObject does not render at all when an SVG is loaded
  // through <img>. Left on, every diagram arrives as boxes and arrows with no text in them.
  // With it off, labels are real <text> elements, which an image renderer draws.
  htmlLabels: false,
  // An image-loaded SVG cannot reach the page's fonts either, so the stack has to be one the
  // OS itself will resolve rather than the UI font.
  fontFamily: 'Arial, Helvetica, sans-serif',
};

let mermaidModule: Promise<typeof import('mermaid').default> | undefined;

/**
 * Mermaid is several hundred kB and most sessions never produce a diagram, so it is fetched on
 * the first one rather than carried in the renderer's startup bundle forever.
 */
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidModule) {
    const pending = import('mermaid').then(module => module.default);
    // A chunk that failed to load once must not leave every later diagram holding the same
    // rejected promise.
    pending.catch(() => {
      if (mermaidModule === pending) mermaidModule = undefined;
    });
    mermaidModule = pending;
  }
  return mermaidModule;
}

/**
 * Mermaid sizes its SVG for a container it expects to be dropped into: `width="100%"`, with
 * the diagram's real width only as a `max-width` style. An `<img>` has no such container, so
 * the picture has no intrinsic size and stretches to fill whatever the CSS allows - a
 * five-box flowchart arrives poster-sized, with text several times the UI's. Giving the root
 * the pixel size its own viewBox already states restores an intrinsic size, which the card's
 * maxWidth and maxHeight then clamp rather than inflate.
 *
 * Rewritten as text on the opening tag rather than by parsing the document. Nothing about
 * this needs a parser, and the promise worth keeping about a model's SVG is that it never
 * becomes one.
 */
function withIntrinsicSize(svg: string): string {
  const viewBox = /<svg\b[^>]*\bviewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!viewBox) return svg;

  return svg.replace(/<svg\b[^>]*>/, tag =>
    tag
      .replace(/\s(?:width|height)="[^"]*"/g, '')
      // Only the sizing declaration goes; the dark theme also puts its background here.
      .replace(/\sstyle="([^"]*)"/, (_whole, style: string) => {
        const kept = style
          .replace(/(^|;)\s*max-width\s*:[^;]*/gi, '$1')
          .replace(/^;+|;+$/g, '')
          .trim();
        return kept ? ` style="${kept}"` : '';
      })
      .replace(/^<svg\b/, `<svg width="${viewBox[1]}" height="${viewBox[2]}"`)
  );
}

let sequence = 0;

export async function renderMermaidDiagram(source: string, mode: 'light' | 'dark'): Promise<MermaidResult> {
  const id = `chat-artifact-mermaid-${(sequence += 1)}`;

  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({ ...MERMAID_CONFIG, theme: mode === 'dark' ? 'dark' : 'default' });

    const { svg } = await mermaid.render(id, source);

    // A few diagram types - journey, mindmap - build their labels out of <foreignObject> no
    // matter what htmlLabels says. As an image those come out blank, which reads as a broken
    // renderer rather than an unsupported diagram, so they go to source instead.
    return svg.includes('foreignObject')
      ? { ok: false, reason: 'html-labels' }
      : { ok: true, svg: withIntrinsicSize(svg) };
  } catch {
    return { ok: false, reason: 'invalid' };
  } finally {
    // Mermaid measures text in a detached-looking element it parks in the document, and it
    // only clears that up on the path where nothing threw.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}
