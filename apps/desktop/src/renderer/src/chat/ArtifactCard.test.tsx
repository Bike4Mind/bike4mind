import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactCard } from './ArtifactCard';

// The drawing yields space to an expanded source disclosure. Its footer must also be able
// to shrink and scroll when that source and the publish controls exceed the opened panel.
describe('ArtifactCard', () => {
  it('keeps source and share controls scrollable in a filled rendered card', () => {
    const markup = renderToStaticMarkup(
      <ArtifactCard
        fill
        artifact={{ id: 'long-svg', type: 'svg', title: 'Long SVG', content: '<svg>\n'.repeat(100) }}
      />
    );
    // The footer alone combines the rendered card's top border and a shrinking scroll area.
    expect(markup).toMatch(/\.[\w-]+\{[^}]*min-height:0;overflow-y:auto;[^}]*border-top:1px solid/);
  });
});
