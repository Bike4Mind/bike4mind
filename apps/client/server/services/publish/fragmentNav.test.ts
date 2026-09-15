import { describe, it, expect } from 'vitest';
import { buildFragmentNavScriptTag, HASH_BRIDGE_JS } from './fragmentNav';

describe('buildFragmentNavScriptTag', () => {
  it('serializes origins and trailing-slash-normalized, deduped paths into the config', () => {
    const tag = buildFragmentNavScriptTag({
      origins: ['https://app.example.com', '', 'https://app.example.com'],
      paths: ['/p/u/scope/slug/', '/p/u/scope/slug', '/a/tok123'],
    });
    expect(tag).toContain('"origins":["https://app.example.com"]');
    expect(tag).toContain('"paths":["/p/u/scope/slug","/a/tok123"]');
    expect(tag).not.toContain('__B4M_FRAGMENT_CFG__');
  });

  it('escapes < in config values so a crafted path cannot close the script tag', () => {
    const tag = buildFragmentNavScriptTag({
      origins: ['https://app.example.com'],
      paths: ['/p/u/scope/</script><script>alert(1)'],
    });
    expect(tag.indexOf('</script>')).toBe(tag.length - '</script>'.length);
    expect(tag).toContain('\\u003c/script>');
  });

  it('neither script contains a literal </script> of its own', () => {
    const tag = buildFragmentNavScriptTag({ origins: ['https://a.b'], paths: ['/p/u/x/y'] });
    const inner = tag.slice('<script>'.length, -'</script>'.length);
    expect(inner).not.toContain('</script>');
    expect(HASH_BRIDGE_JS).not.toContain('</script>');
  });
});
