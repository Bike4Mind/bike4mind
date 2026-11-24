// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({ SkillListingTemplate: {} }));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({ findListing: vi.fn() }));
vi.mock('@server/services/publish/prepareShareMeta', () => ({ prepareShareMeta: () => ({ metaTags: '' }) }));
vi.mock('./template', () => ({ isLive: () => true }));

import { renderTemplatePage, type TemplatePageView } from './templatePage';

const view: TemplatePageView = {
  slug: 'article-bullets',
  skillName: 'article-bullets',
  headline: 'Five bullets',
  inputs: [],
  imageSrc: null,
  starterCredits: 0,
  brandName: 'Acme',
  share: null,
  freeRun: { state: 'open', siteKey: 'site-key', inputMaxChars: 8000 },
};

const byTestId = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.querySelector(`[data-testid="${id}"]`) as T;

const turnstile = { render: vi.fn(), reset: vi.fn() };
const mermaid = { initialize: vi.fn(), render: vi.fn() };
const loaded: string[] = [];
let solve: (token: string) => void = () => undefined;

function mountPage(pageView: TemplatePageView = view) {
  const html = renderTemplatePage(pageView);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script>[\s\S]*?<\/script>/, '');
  // Stand-in for the external scripts: report them loaded at once.
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T) => {
    const el = node as unknown as HTMLScriptElement;
    loaded.push(el.src);
    queueMicrotask(() => el.onload?.(new Event('load')));
    return node;
  });
  new Function(script)();
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function submit(text: string) {
  byTestId<HTMLTextAreaElement>('template-page-free-run-input').value = text;
  byTestId<HTMLFormElement>('template-page-free-run-form').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true })
  );
  await flush();
  await flush();
}

const respond = (status: number, body: unknown) =>
  vi.mocked(fetch).mockResolvedValueOnce({ status, json: async () => body } as Response);

beforeEach(async () => {
  loaded.length = 0;
  localStorage.clear();
  Object.assign(window, { turnstile, mermaid });
  turnstile.render.mockImplementation((_target: string, opts: { callback: (t: string) => void }) => {
    solve = opts.callback;
    return 'widget-1';
  });
  mermaid.render.mockResolvedValue({ svg: '<svg data-x="1"></svg>' });
  vi.stubGlobal('fetch', vi.fn());
  mountPage();
  await flush();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('template page free-run box', () => {
  it('shows no file picker when the model takes no files', () => {
    expect(byTestId('template-page-free-run-file-row')).toBeNull();
    expect(byTestId('template-page-free-run-file')).toBeNull();
  });

  it('renders the Turnstile widget with the run action and site key', () => {
    expect(loaded[0]).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
    expect(turnstile.render).toHaveBeenCalledWith(
      '#free-run-widget',
      expect.objectContaining({ sitekey: 'site-key', action: 'skill-free-run' })
    );
  });

  it('asks for the check before running', async () => {
    await submit('An article');
    expect(fetch).not.toHaveBeenCalled();
    expect(byTestId('template-page-free-run-status').textContent).toBe('Finish the check above first.');
  });

  it('runs, shows the result, keeps the text for the try route and swaps in the sign-up prompt', async () => {
    solve('tok');
    respond(200, { html: '<h2>Plan</h2><ul><li><input type="checkbox" /> one</li></ul>', hasDiagram: false });
    await submit('  An article  ');

    expect(fetch).toHaveBeenCalledWith(
      '/api/skills/template/run/article-bullets',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'An article', turnstileToken: 'tok' }) })
    );
    expect(byTestId('template-page-free-run-result').hidden).toBe(false);
    expect(byTestId('template-page-free-run-result').querySelector('h2')?.textContent).toBe('Plan');
    expect(byTestId('template-page-free-run-form').hidden).toBe(true);
    expect(byTestId('template-page-free-run-signup').hidden).toBe(false);
    expect(byTestId<HTMLAnchorElement>('template-page-free-run-signup-btn').getAttribute('href')).toBe(
      '/skills/market/try/article-bullets'
    );
    expect(localStorage.getItem('b4m.skillTemplate.freeRunInput.article-bullets')).toBe('An article');
    expect(loaded.some(src => src.includes('mermaid'))).toBe(false);
  });

  it('loads mermaid only for a result with a diagram and draws it', async () => {
    solve('tok');
    respond(200, { html: '<pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>', hasDiagram: true });
    await submit('An article');
    await flush();
    expect(loaded.filter(src => src.includes('mermaid@'))).toHaveLength(1);
    expect(mermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false, securityLevel: 'strict' });
    expect(mermaid.render).toHaveBeenCalledWith('free-run-diagram-0', 'graph TD; A-->B');
    expect(byTestId('template-page-free-run-diagram')).not.toBeNull();
  });

  it.each(['free_run_used', 'free_run_capped'])('shows the sign-up prompt on %s', async code => {
    solve('tok');
    respond(429, { code, error: 'Sign up to keep going.' });
    await submit('An article');
    expect(byTestId('template-page-free-run-signup').hidden).toBe(false);
    expect(byTestId('template-page-free-run-result').hidden).toBe(true);
    expect(localStorage.getItem('b4m.skillTemplate.freeRunInput.article-bullets')).toBe('An article');
  });

  it('keeps the box and resets the check after a failed run', async () => {
    solve('tok');
    respond(502, { code: 'free_run_failed', error: 'The run could not finish.' });
    await submit('An article');
    expect(byTestId('template-page-free-run-form').hidden).toBe(false);
    expect(byTestId<HTMLButtonElement>('template-page-free-run-btn').disabled).toBe(false);
    expect(byTestId('template-page-free-run-status').textContent).toBe('The run could not finish.');
    expect(turnstile.reset).toHaveBeenCalledWith('widget-1');
  });
});

describe('template page free-run file picker', () => {
  const pick = (...files: File[]) => {
    const input = byTestId<HTMLInputElement>('template-page-free-run-file');
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
    return input;
  };

  beforeEach(async () => {
    loaded.length = 0;
    mountPage({ ...view, freeRun: { state: 'open', siteKey: 'site-key', inputMaxChars: 8000, file: { maxBytes: 1024 } } });
    await flush();
  });

  it('offers one PDF, image or text file with the size cap', () => {
    const input = byTestId<HTMLInputElement>('template-page-free-run-file');
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(false);
    expect(input.accept).toContain('application/pdf');
    expect(input.accept).toContain('image/png');
    expect(input.accept).toContain('text/plain');
    expect(byTestId('template-page-free-run-file-row').textContent).toContain('up to 1 KB');
  });

  it('sends the file with the run, with or without pasted text', async () => {
    solve('tok');
    respond(200, { html: '<p>done</p>', hasDiagram: false });
    pick(new File(['hello file'], 'notes.txt', { type: 'text/plain' }));
    await submit('');
    await flush();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body).toEqual({
      text: '',
      turnstileToken: 'tok',
      file: { name: 'notes.txt', type: 'text/plain', data: Buffer.from('hello file').toString('base64') },
    });
    expect(byTestId('template-page-free-run-result').hidden).toBe(false);
  });

  it('asks for text or a file when both are empty', async () => {
    solve('tok');
    await submit('');
    expect(fetch).not.toHaveBeenCalled();
    expect(byTestId('template-page-free-run-status').textContent).toBe('Paste some text or attach a file first.');
  });

  it('refuses a file over the cap without sending it', async () => {
    solve('tok');
    const input = pick(new File(['x'.repeat(2048)], 'big.txt', { type: 'text/plain' }));
    expect(byTestId('template-page-free-run-status').textContent).toBe('Attach a file under 1 KB.');
    expect(input.value).toBe('');
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    await submit('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a second file without sending either', async () => {
    solve('tok');
    pick(new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.txt', { type: 'text/plain' }));
    expect(byTestId('template-page-free-run-status').textContent).toBe('Attach one file only.');
    await submit('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the refusal the run route gives for a file', async () => {
    solve('tok');
    respond(400, { code: 'file_too_many_pages', error: 'Attach a PDF of 10 pages or fewer.' });
    pick(new File(['%PDF-'], 'long.pdf', { type: 'application/pdf' }));
    await submit('');
    await flush();
    await flush();
    expect(byTestId('template-page-free-run-status').textContent).toBe('Attach a PDF of 10 pages or fewer.');
    expect(byTestId('template-page-free-run-form').hidden).toBe(false);
    expect(byTestId<HTMLButtonElement>('template-page-free-run-btn').disabled).toBe(false);
  });
});
