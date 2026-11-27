import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import SafeSvgImage from './SafeSvgImage';

describe('SafeSvgImage', () => {
  it('renders the svg as an image rather than inline markup', () => {
    const { container } = render(
      <SafeSvgImage
        svg={
          '<svg viewBox="0 0 10 10"><style>body{display:none}</style><image href="https://example.com/a.png" /><circle r="4" /></svg>'
        }
        alt="Diagram"
        testId="safe-svg-image"
      />
    );
    const image = screen.getByTestId('safe-svg-image');
    expect(image.tagName).toBe('IMG');
    expect(image).toHaveAttribute('alt', 'Diagram');
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('style')).toBeNull();
    const markup = decodeURIComponent(image.getAttribute('src') ?? '');
    expect(markup).toContain('<circle');
    expect(markup).not.toContain('example.com');
  });

  it('renders nothing when the content holds no svg', () => {
    const { container } = render(<SafeSvgImage svg="not svg" alt="x" />);
    expect(container).toBeEmptyDOMElement();
  });
});
