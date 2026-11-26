import { describe, it, expect } from 'vitest';
import { assertNoRemoteDiagramResources, MERMAID_RESOURCE_CONFIG, mermaidOptions } from './mermaidSecurity';

describe('assertNoRemoteDiagramResources', () => {
  it.each([
    'graph TD\n A\n style A fill:url(https://example.com/x)',
    'flowchart TD\n A@{ img: "https://example.com/p.png", label: "x" }',
    'flowchart TD\n A@{ shape: rect, img: https://example.com/p.png }',
    'flowchart TD\n A@{ label: "}", img: "https://example.com/p.png" }',
    'flowchart TD\n A@{ "img": "https://example.com/p.png" }',
    'flowchart TD\n A@{ "\\x69mg": "https://example.com/p.png" }',
    'flowchart TD\n A@{ label: &k img }\n B@{ *k : "https://example.com/p.png" }',
    '%%{init: {"themeVariables": {"fontFamily": "x;background:url(https://evil.example/a.png)"}}}%%\ngraph TD\n A-->B',
    'flowchart TD\n A@{\n  shape: rect\n  img: https://example.com/a.png\n}',
    'flowchart TD\n A@{ "im\\\ng": "https://example.com/a.png" }',
    'kanban\n  todo[Todo]\n    t1[Task]@{ img: "https://example.com/p.png" }',
  ])('refuses %s', definition => {
    expect(() => assertNoRemoteDiagramResources(definition)).toThrow();
  });

  it.each([
    'graph TD\n A["https://example.com/docs"]-->B',
    'graph TD\n A["@import rules"]-->B',
    'sequenceDiagram\n A->>B: getUrl()\n B->>A: new URL(path)',
    'flowchart TD\n A@{ shape: rect, label: "Start" } --> B',
    'flowchart TD\n A@{ img: "data:image/png;base64,AAAA", h: 40 }',
    'graph TD\n A["img folder"]-->B',
    'flowchart TD\n A@{ shape: rect }\n B["Resize img"]',
    'flowchart TD\n A@{ shape: rect, label: "Resize img" }',
    '%%{init: {"themeVariables": {"primaryColor": "#ff0000"}}}%%\ngraph TD\n A-->B',
  ])('accepts %s', definition => {
    expect(() => assertNoRemoteDiagramResources(definition)).not.toThrow();
  });
});

describe('mermaidOptions', () => {
  it('pins the resource config and strict security for both themes', () => {
    for (const isDark of [false, true]) {
      const options = mermaidOptions(isDark);
      expect(options.securityLevel).toBe('strict');
      expect(options.secure).toEqual(MERMAID_RESOURCE_CONFIG.secure);
      expect(options.dompurifyConfig).toEqual(MERMAID_RESOURCE_CONFIG.dompurifyConfig);
      expect(options.theme).toBe(isDark ? 'dark' : 'default');
    }
  });

  it('locks every option that could add a resource load against directives', () => {
    expect(MERMAID_RESOURCE_CONFIG.secure).toEqual([
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'suppressErrorRendering',
      'maxEdges',
      'dompurifyConfig',
      'themeCSS',
    ]);
  });

  it('leaves themeVariables and fontFamily unlocked while themeCSS stays locked', () => {
    expect(MERMAID_RESOURCE_CONFIG.secure).not.toContain('themeVariables');
    expect(MERMAID_RESOURCE_CONFIG.secure).not.toContain('fontFamily');
    expect(MERMAID_RESOURCE_CONFIG.secure).toContain('themeCSS');
  });
});
