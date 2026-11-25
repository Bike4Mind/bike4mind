// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({ SkillListingTemplate: {} }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ findListing: vi.fn() }));
vi.mock('@server/services/publish/prepareShareMeta', () => ({ prepareShareMeta: () => ({ metaTags: '' }) }));
vi.mock('./template', () => ({ isLive: () => true }));

import { renderTemplatePage, type TemplatePageView } from './templatePage';

const view: TemplatePageView = {
  slug: 'launch-plan',
  skillName: 'launch-plan',
  headline: 'Plans',
  inputs: [],
  imageSrc: null,
  starterCredits: 0,
  brandName: 'Acme',
  share: null,
  freeRun: null,
  example: {
    prompt: 'Plan it',
    replyHtml: '<p>Plan</p>',
    steps: [{ label: 'Read issues', simulated: false }],
    artifact: { title: 'Plan', html: '<h2>One</h2><p>Two</p>' },
    media: null,
    sampleFile: null,
  },
};

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const panel = () => byTestId('template-page-example-panel');

function mount(reducedMotion: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: reducedMotion }) as never;
  const html = renderTemplatePage(view);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script>[\s\S]*?<\/script>/, '');
  new Function(script)();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('template page example script', () => {
  it('hides everything, then reveals the thread and opens the panel block by block', () => {
    mount(false);
    const reply = byTestId('template-page-example-reply');
    expect(reply.classList.contains('ex-pending')).toBe(true);
    expect(panel().classList.contains('open')).toBe(false);
    expect(byTestId('template-page-example-replay').hidden).toBe(false);

    vi.advanceTimersByTime(20_000);
    expect(document.querySelectorAll('.ex-pending')).toHaveLength(0);
    expect(panel().classList.contains('open')).toBe(true);
    expect(panel().querySelectorAll('.ex-in')).toHaveLength(2);
  });

  it('closes the panel and reopens it from the chip', () => {
    mount(false);
    vi.advanceTimersByTime(20_000);
    byTestId('template-page-example-panel-close').click();
    expect(panel().classList.contains('open')).toBe(false);
    expect(byTestId('template-page-example-artifact-chip').getAttribute('aria-expanded')).toBe('false');
    byTestId('template-page-example-artifact-chip').click();
    expect(panel().classList.contains('open')).toBe(true);
  });

  it('replays from the start', () => {
    mount(false);
    vi.advanceTimersByTime(20_000);
    byTestId('template-page-example-replay').click();
    expect(byTestId('template-page-example-user').classList.contains('ex-pending')).toBe(true);
    expect(panel().classList.contains('open')).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(document.querySelectorAll('.ex-pending')).toHaveLength(0);
  });

  it('leaves the final state alone under reduced motion, with no replay', () => {
    mount(true);
    expect(document.querySelectorAll('.ex-pending')).toHaveLength(0);
    expect(panel().classList.contains('open')).toBe(true);
    expect(byTestId('template-page-example-replay').hidden).toBe(true);
    byTestId('template-page-example-panel-close').click();
    expect(panel().classList.contains('open')).toBe(false);
  });
});
