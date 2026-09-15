import { describe, it, expect } from 'vitest';
import { sanitizeSvg } from './svg';

// SMIL animation elements can rewrite an <a href> to javascript: at runtime, so they must
// not survive sanitization even though the rest of the SVG profile is allowed.
describe('sanitizeSvg', () => {
  it('strips SMIL animation elements', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" to="javascript:alert(1)" />' +
      '<set attributeName="href" to="javascript:alert(1)" /><text>x</text></a></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('<animate');
    expect(clean).not.toContain('<set');
    expect(clean).not.toContain('javascript:');
  });

  it('keeps ordinary shapes', () => {
    const clean = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>');
    expect(clean).toContain('<rect');
  });

  it('strips event-handler attributes', () => {
    const clean = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect onload="steal()" /></svg>');
    expect(clean).not.toContain('onload');
  });
});
