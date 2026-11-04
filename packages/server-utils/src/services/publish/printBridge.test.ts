import { describe, it, expect } from 'vitest';
import { buildPrintBridgeTag, PRINT_BRIDGE_CSS, PRINT_BRIDGE_JS } from './printBridge';

describe('buildPrintBridgeTag', () => {
  it('ships the print trigger and the print stylesheet in one tag', () => {
    const tag = buildPrintBridgeTag();
    expect(tag).toContain('window.print');
    expect(tag).toContain('print-color-adjust');
    expect(tag).toContain(`<style>${PRINT_BRIDGE_CSS}</style>`);
    expect(tag.endsWith('</script>')).toBe(true);
  });

  it('never contains a literal </script> inside the script body', () => {
    const tag = buildPrintBridgeTag();
    const inner = tag.slice(tag.indexOf('<script>') + '<script>'.length, -'</script>'.length);
    expect(inner).not.toContain('</script>');
    expect(PRINT_BRIDGE_JS).not.toContain('</script>');
  });

  it('undoes the two author defaults that clip a print to one blank-backgrounded page', () => {
    // `body{height:100vh;overflow:auto}` paginates to a single page, and backgrounds are
    // dropped unless the viewer ticks Chrome's "Background graphics" box.
    expect(PRINT_BRIDGE_CSS).toContain('overflow:visible!important');
    expect(PRINT_BRIDGE_CSS).toContain('height:auto!important');
    expect(PRINT_BRIDGE_CSS).toContain('-webkit-print-color-adjust:exact!important');
  });
});
