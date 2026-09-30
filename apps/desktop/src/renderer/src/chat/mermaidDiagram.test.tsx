// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { SvgArtifact } from './ArtifactCard';
import { renderMermaidDiagram } from './mermaidDiagram';

/**
 * Against the real mermaid, not a stand-in. What is worth asserting here is what mermaid's
 * output does when it is loaded as an image, and a mock has no opinion about that - the
 * foreignObject case below is invisible to any test that fakes the SVG.
 */

const FLOWCHART = `flowchart TD
    Start([Start Signup]) --> Email[Enter Email]
    Email --> Password[Create Password]
    Password --> Complete[Complete Registration]
    Complete --> End([Success!])`;

const SEQUENCE = `sequenceDiagram
    Alice->>John: Hello John, how are you?
    John-->>Alice: Great!`;

/** A journey is the shape mermaid can only draw with embedded HTML. */
const JOURNEY = `journey
    title My day
    section Go to work
      Make tea: 5: Me`;

const MALFORMED = `flowchart TD
  A --> ((((`;

/** What the diagram would read as, with the markup and the theme's CSS taken out. */
function drawnText(svg: string): string {
  return svg.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
}

beforeAll(() => {
  // jsdom implements no SVG layout, so mermaid's text measurement finds nothing to call.
  // Real geometry is not what these tests are about; the boxes just need a size to be laid
  // out with, and Chromium supplies these for real in the app.
  const svgProto = SVGElement.prototype as unknown as Record<string, unknown>;
  svgProto.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });
  svgProto.getComputedTextLength = () => 100;
  svgProto.getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
});

describe('compiling a diagram', () => {
  it('turns a flowchart into an image the card can show', async () => {
    const result = await renderMermaidDiagram(FLOWCHART, 'light');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const markup = renderToStaticMarkup(
      <SvgArtifact content={result.svg} title="Signup" testId="chat-artifact-mermaid" />
    );
    expect(markup).toContain('<img');
    expect(markup).toContain('src="data:image/svg+xml;charset=utf-8,');
    expect(markup).toContain('data-testid="chat-artifact-mermaid"');
  });

  /**
   * The htmlLabels regression, and the reason that setting carries a comment. Mermaid's
   * default wraps every label in a <foreignObject>, which an <img>-loaded SVG does not render
   * - the diagram arrives with its boxes and arrows intact and every label blank, so a test
   * that only checks the render succeeded still passes.
   */
  it.each([
    ['flowchart', FLOWCHART, ['Enter', 'Email', 'Success!']],
    ['sequence', SEQUENCE, ['Alice', 'Great!']],
  ])('draws %s labels as SVG text rather than embedded HTML', async (_name, source, words) => {
    const result = await renderMermaidDiagram(source, 'light');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.svg).not.toContain('foreignObject');
    expect(result.svg).toContain('<text');
    // Word by word, against the text the diagram would show rather than the markup: jsdom
    // reports the same width for every string, so mermaid breaks each label across tspans
    // here in a way a real browser would not.
    for (const word of words) expect(drawnText(result.svg)).toContain(word);
  });

  it('follows the appearance, so a dark diagram is not painted for a light one', async () => {
    const [light, dark] = await Promise.all([
      renderMermaidDiagram(FLOWCHART, 'light'),
      renderMermaidDiagram(FLOWCHART, 'dark'),
    ]);
    expect(light.ok && dark.ok).toBe(true);
    if (!light.ok || !dark.ok) return;

    expect(light.svg).not.toEqual(dark.svg);
  });
});

describe('a diagram that cannot be a picture', () => {
  it('reports a malformed source instead of throwing', async () => {
    await expect(renderMermaidDiagram(MALFORMED, 'light')).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  // Mermaid otherwise paints its own "Syntax error" graphic straight into this document.
  it('leaves nothing of the attempt in the transcript', async () => {
    await renderMermaidDiagram(MALFORMED, 'light');

    expect(document.body.textContent).not.toContain('Syntax error');
    expect(document.body.querySelector('svg')).toBeNull();
  });

  it('sends a kind mermaid can only draw with embedded HTML to source', async () => {
    await expect(renderMermaidDiagram(JOURNEY, 'light')).resolves.toEqual({ ok: false, reason: 'html-labels' });
  });
});
