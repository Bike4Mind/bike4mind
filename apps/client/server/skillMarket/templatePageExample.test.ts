// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({ SkillListingTemplate: {} }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ findListing: vi.fn() }));
vi.mock('./template', () => ({ isLive: () => true }));

import {
  MERMAID_SCRIPT_SRC,
  TEMPLATE_EXAMPLE_SCRIPT_HASH,
  TEMPLATE_FREE_RUN_SCRIPT_HASH,
  renderTemplatePage,
  templatePageCsp,
  type TemplatePageView,
} from './templatePage';
import { fileTypeLabel, type TemplatePageExampleView } from './templatePageExample';

const example: TemplatePageExampleView = {
  prompt: 'Plan the launch of our app',
  replyHtml: '<p>Here is the plan.</p>',
  steps: [
    { label: 'Read 3 issues', simulated: false },
    { label: 'Posted a comment', simulated: true },
  ],
  artifact: { title: 'Launch plan', html: '<h2>Week 1</h2><p>Ship it.</p>' },
  media: null,
  sampleFile: null,
};

const view: TemplatePageView = {
  slug: 'launch-plan',
  skillName: 'launch-plan',
  headline: 'Turn a goal into a ready-to-share action plan',
  inputs: [{ label: 'Your goal', required: true }],
  authorName: 'Ada',
  rating: { sum: 9, count: 2 },
  connectors: [],
  takesFile: false,
  example,
  imageSrc: '/api/skills/template/image/launch-plan?v=f1',
  starterCredits: 2500,
  brandName: 'Acme',
  share: null,
  freeRun: null,
};

const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

describe('template page with an example', () => {
  it('draws two columns: the lead and the chat window titled Example with a replay button', () => {
    const html = renderTemplatePage(view);
    expect(html).toContain('<main class="wide" data-testid="template-page">');
    expect(html).toContain('data-testid="template-page-lead"');
    expect(html).toContain('data-testid="template-page-example"');
    expect(html).toContain('<span>Example</span>');
    expect(html).toContain('data-testid="template-page-example-replay"');
    expect(html).toContain('data-testid="template-page-try-btn"');
    expect(html).toContain('New accounts start with 2,500 free credits.');
    // The preview image is for link previews; the window replaces it on the page.
    expect(html).not.toContain('template-page-preview-image');
  });

  it('removes the skill badge, the slug pill and the input chips', () => {
    for (const html of [renderTemplatePage(view), renderTemplatePage({ ...view, example: null })]) {
      expect(html).not.toContain('template-page-badge');
      expect(html).not.toContain('template-page-input-chip');
      expect(html).not.toContain('You bring');
      expect(html).not.toContain('Acme skill <code>');
    }
  });

  it('shows the user message with the slash-command chip, then steps, the used-skill line and the reply', () => {
    const html = renderTemplatePage(view);
    const order = [
      'data-testid="template-page-example-skill-chip">/launch-plan</span>Plan the launch of our app',
      'Read 3 issues',
      'Posted a comment <span class="ex-sim" data-testid="template-page-example-simulated">simulated</span>',
      'Used skill <strong>launch-plan</strong>',
      '<p>Here is the plan.</p>',
      'data-testid="template-page-example-artifact-chip"',
    ].map(fragment => html.indexOf(fragment));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/template-page-example-simulated/g)).toHaveLength(1);
  });

  it('renders the final state in the HTML: every item visible and the artifact panel open', () => {
    const html = renderTemplatePage(view);
    expect(html).not.toMatch(/class="[^"]*ex-pending/);
    expect(html).toContain('<aside id="example-panel" class="ex-panel open"');
    expect(html).toContain('<div class="ex-doc" data-ex-blocks><h2>Week 1</h2><p>Ship it.</p></div>');
    expect(html).toContain('aria-expanded="true" data-ex-step="450"');
    expect(html).toContain('<span>Launch plan</span>');
    // Controls that only work with the script stay hidden without it.
    expect(html).toMatch(/id="example-replay" class="ex-js" hidden/);
    expect(html).toMatch(/id="example-panel-close" class="ex-js"/);
  });

  it('carries the reduced-motion and narrow-screen rules', () => {
    const html = renderTemplatePage(view);
    expect(html).toContain('@media (prefers-reduced-motion: reduce){');
    expect(html).toMatch(/@media \(max-width: 880px\)\{[^@]*\.ex-live \.ex-panel\{position:static/);
  });

  it('stacks the panel under the thread until the script runs; only then does it overlay', () => {
    const html = renderTemplatePage(view);
    // Base rules (no script) never position the panel over the thread.
    expect(html).toMatch(/\n {2}\.ex-panel\{display:flex;[^}]*max-height:34rem\}/);
    expect(html).not.toMatch(/\n {2}\.ex-panel\{[^}]*position:absolute/);
    expect(html).not.toMatch(/\n {2}\.ex-panel:not\(\.open\)/);
    expect(html).toMatch(/\.ex-live \.ex-panel\{position:absolute;[^}]*width:88%/);
    expect(html).toContain('.ex-live .ex-panel:not(.open){transform:translateX(102%)');
    expect(html).toContain('.ex-live .ex-stage{height:36rem}');
    expect(html).not.toContain('class="ex ex-live"');
  });

  it('plays the chat only when the run made no artifact or media', () => {
    const html = renderTemplatePage({ ...view, example: { ...example, artifact: null } });
    expect(html).not.toContain('id="example-panel"');
    expect(html).not.toContain('id="example-artifact-chip"');
    expect(html).toContain('<p>Here is the plan.</p>');
  });

  it('shows the file card only with a sample file', () => {
    expect(renderTemplatePage(view)).not.toContain('template-page-example-file');
    const html = renderTemplatePage({
      ...view,
      example: { ...example, sampleFile: { name: 'brief.pdf', mime: 'application/pdf', pages: 3 } },
    });
    expect(html).toContain('data-testid="template-page-example-file"');
    expect(html).toContain(
      '<span class="ex-file-name">brief.pdf</span><span class="ex-file-meta">PDF \u00b7 3 pages</span>'
    );
    expect(html.indexOf('template-page-example-file')).toBeLessThan(html.indexOf('template-page-example-skill-chip'));
  });

  it('names file types for the card', () => {
    expect(fileTypeLabel('application/pdf')).toBe('PDF');
    expect(fileTypeLabel('image/png')).toBe('Image');
    expect(fileTypeLabel('text/plain; charset=utf-8')).toBe('Text');
    expect(fileTypeLabel('application/vnd.ms-excel')).toBe('MS-EXCEL');
  });

  it('draws the input bar with the skill chip, the first input label and a paperclip only for file skills', () => {
    const html = renderTemplatePage(view);
    expect(html).toMatch(
      /data-testid="template-page-example-input">\s*<span class="ex-skill-chip">\/launch-plan<\/span>\s*<span class="ex-placeholder">Your goal<\/span>/
    );
    expect(html).not.toContain('template-page-example-paperclip');
    expect(renderTemplatePage({ ...view, takesFile: true })).toContain('data-testid="template-page-example-paperclip"');
  });

  describe('media', () => {
    const item = { src: 'https://media.example.com/a?sig=1', mime: 'image/png', width: 1080, height: 1350 };

    it('plays a video muted and inline with controls', () => {
      const html = renderTemplatePage({
        ...view,
        example: { ...example, artifact: null, media: { kind: 'video', items: [{ ...item, mime: 'video/mp4' }] } },
      });
      expect(html).toContain(
        '<video class="ex-video" src="https://media.example.com/a?sig=1" muted playsinline controls preload="metadata" data-testid="template-page-example-video"></video>'
      );
      expect(html).toContain('.ex-video{display:block;width:100%;max-width:20rem;aspect-ratio:9/16');
      expect(html).toContain('<span>Result</span>');
    });

    it('shows one image', () => {
      const html = renderTemplatePage({ ...view, example: { ...example, media: { kind: 'image', items: [item] } } });
      expect(html).toContain(
        '<figure class="ex-image" data-testid="template-page-example-image"><img src="https://media.example.com/a?sig=1" width="1080" height="1350" alt="Example result of /launch-plan"></figure>'
      );
      // Media first, then the artifact, in one panel.
      expect(html.indexOf('ex-image')).toBeLessThan(html.indexOf('<h2>Week 1</h2>'));
    });

    it('lays a carousel out as swipeable slides', () => {
      const html = renderTemplatePage({
        ...view,
        example: { ...example, artifact: null, media: { kind: 'carousel', items: [item, item, item] } },
      });
      expect(html).toContain('data-testid="template-page-example-carousel"');
      expect(html.match(/class="ex-slide"/g)).toHaveLength(3);
      expect(html).toContain('alt="Example result of /launch-plan, slide 2 of 3"');
      expect(html).toContain('scroll-snap-type:x mandatory');
    });
  });

  describe('left column', () => {
    it('shows the author and the average rating', () => {
      expect(renderTemplatePage(view)).toContain(
        'data-testid="template-page-byline">Ada \u00b7 <span data-testid="template-page-rating">\u2605 4.5 (2)</span></p>'
      );
    });

    it('falls back to a generic author and omits a rating with no votes', () => {
      const html = renderTemplatePage({ ...view, authorName: '', rating: { sum: 0, count: 0 } });
      expect(html).toContain('data-testid="template-page-byline">A Bike4Mind user</p>');
      expect(html).not.toContain('template-page-rating');
    });

    it('lists each connector the skill needs', () => {
      const html = renderTemplatePage({ ...view, connectors: ['GitHub', 'Notion'] });
      expect(html).toContain('data-testid="template-page-connector">Needs GitHub connected</p>');
      expect(html).toContain('data-testid="template-page-connector">Needs Notion connected</p>');
      expect(renderTemplatePage(view)).not.toContain('template-page-connector');
    });

    it('keeps the single-column page, byline included, without an example', () => {
      const html = renderTemplatePage({ ...view, example: null, connectors: ['GitHub'] });
      expect(html).toContain('<main data-testid="template-page">');
      expect(html).not.toContain('template-page-example');
      expect(html).not.toContain('<script');
      expect(html).toContain('data-testid="template-page-preview-image"');
      expect(html).toContain('Needs GitHub connected');
      expect(html).toContain('>Ada');
    });
  });

  it('escapes every author- and model-derived string', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const html = renderTemplatePage({
      ...view,
      headline: evil,
      skillName: evil,
      authorName: evil,
      connectors: [evil],
      inputs: [{ label: evil, required: true }],
      takesFile: true,
      example: {
        prompt: evil,
        replyHtml: '<p>safe</p>',
        steps: [{ label: evil, simulated: true }],
        artifact: { title: evil, html: '<p>doc</p>' },
        media: {
          kind: 'carousel',
          items: [
            { src: `https://m.example.com/${evil}`, mime: 'image/png' },
            { src: 'https://m.example.com/b', mime: 'image/png' },
          ],
        },
        sampleFile: { name: evil, mime: evil, pages: 2 },
      },
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('alert(1)>');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  describe('scripts and CSP', () => {
    it('adds one hashed example script, identical across pages', () => {
      const one = scripts(renderTemplatePage(view));
      const other = scripts(
        renderTemplatePage({ ...view, slug: 'other', example: { ...example, artifact: null, prompt: 'x' } })
      );
      expect(one).toHaveLength(1);
      expect(sha(one[0])).toBe(TEMPLATE_EXAMPLE_SCRIPT_HASH);
      expect(other).toEqual(one);
    });

    it('runs the free-run script and the example script side by side, each by its hash', () => {
      const html = renderTemplatePage({ ...view, freeRun: { state: 'open', siteKey: 'k', inputMaxChars: 100 } });
      expect(scripts(html).map(sha)).toEqual([TEMPLATE_FREE_RUN_SCRIPT_HASH, TEMPLATE_EXAMPLE_SCRIPT_HASH]);
    });

    it('admits only the scripts a page runs', () => {
      expect(templatePageCsp({ example: null, freeRun: null })).not.toContain('script-src');
      expect(templatePageCsp({ example, freeRun: null })).toMatch(/; script-src 'sha256-[^' ]+'$/);
      expect(templatePageCsp({ example, freeRun: { state: 'open', siteKey: 'k', inputMaxChars: 1 } })).toContain(
        `script-src ${TEMPLATE_EXAMPLE_SCRIPT_HASH} ${TEMPLATE_FREE_RUN_SCRIPT_HASH} https://challenges.cloudflare.com ${MERMAID_SCRIPT_SRC}`
      );
      expect(templatePageCsp({ example, freeRun: { state: 'preview' } })).not.toContain(TEMPLATE_FREE_RUN_SCRIPT_HASH);
      expect(templatePageCsp({ example: null, freeRun: null })).toContain('media-src https:');
      expect(templatePageCsp({ example: null, freeRun: null })).toContain("frame-ancestors 'self'");
    });
  });

  describe('free-run box as the input bar', () => {
    const open = { state: 'open', siteKey: 'k', inputMaxChars: 100, file: { maxBytes: 1024 } } as const;

    it('keeps the free-run ids inside the chat window, with the first input label as placeholder', () => {
      const html = renderTemplatePage({ ...view, freeRun: open });
      const win = html.slice(html.indexOf('data-testid="template-page-example"'));
      for (const id of [
        'free-run',
        'free-run-form',
        'free-run-input',
        'free-run-widget',
        'free-run-btn',
        'free-run-status',
        'free-run-result',
        'free-run-signup',
      ]) {
        expect(win).toContain(`id="${id}"`);
      }
      expect(win).toContain('placeholder="Your goal"');
      expect(win).not.toContain('template-page-example-placeholder');
      // The model takes files, but this skill does not: no paperclip and no file limits.
      expect(html).not.toContain('id="free-run-file"');
      expect(html).not.toContain('data-file-max-bytes="');
    });

    it('wires the paperclip to the free-run file input for a file skill', () => {
      const html = renderTemplatePage({ ...view, takesFile: true, freeRun: open });
      expect(html).toContain('<label for="free-run-file" class="ex-clip"');
      expect(html).toContain('data-testid="template-page-free-run-file"');
      expect(html).toContain('data-file-max-bytes="1024"');
    });

    it('draws an inert box with no script in the preview', () => {
      const html = renderTemplatePage({ ...view, freeRun: { state: 'preview' } });
      expect(html).toContain('data-testid="template-page-free-run-preview"');
      expect(html).toContain('<button type="button" disabled>Try it free</button>');
      expect(html).not.toContain('id="free-run-form"');
      expect(scripts(html).map(sha)).toEqual([TEMPLATE_EXAMPLE_SCRIPT_HASH]);
      const single = renderTemplatePage({ ...view, example: null, freeRun: { state: 'preview' } });
      expect(single).toContain('data-testid="template-page-free-run-preview"');
      expect(single).not.toContain('<script');
    });

    it('puts the sign-up prompt in the bar for a visitor who already ran', () => {
      const html = renderTemplatePage({ ...view, freeRun: { state: 'used' } });
      expect(html).toContain(
        '<div class="ex-run"><div id="free-run-signup" class="run" data-testid="template-page-free-run-signup">'
      );
      expect(html).not.toContain('template-page-example-input');
    });
  });
});
