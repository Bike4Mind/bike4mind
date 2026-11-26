import { createHash, createHmac } from 'node:crypto';
import { SkillListingTemplate, cacheRepository } from '@bike4mind/database';
import {
  TURNSTILE_ACTION_SKILL_FREE_RUN,
  skillTemplateFreeRunInputKey,
  skillTemplatePagePath,
  type ISkillListing,
  type ISkillListingTemplate,
  type ISkillTemplateInput,
} from '@bike4mind/common';
import { findListing } from '@bike4mind/server-utils/skillMarket/market';
import { Config } from '@bike4mind/server-utils/utils/config';
import { escapeHtml } from '@bike4mind/utils/escapeHtml';
import { prepareShareMeta } from '@server/services/publish/prepareShareMeta';
import { isLive } from './template';
import { FREE_RUN_FILE_ACCEPT, formatFileCap } from './templateFreeRunFile';
import {
  EXAMPLE_STYLE,
  TEMPLATE_EXAMPLE_SCRIPT_HASH,
  exampleScriptTag,
  paperclipIcon,
  renderExampleWindow,
  renderStaticInputBar,
  type TemplatePageExampleView,
} from './templatePageExample';

export { TEMPLATE_EXAMPLE_SCRIPT_HASH } from './templatePageExample';

/**
 * The public template page at `/t/<slug>` (pages/api/skills/template/serve.ts): static HTML whose only
 * script is the free-run box's, plus the sign-in loader an organization page is served behind.
 */

export type ServableTemplate = Pick<
  ISkillListingTemplate,
  | 'listingId'
  | 'slug'
  | 'headline'
  | 'inputs'
  | 'previewImage'
  | 'examplePrompt'
  | 'freeRunEnabled'
  | 'takesFile'
  | 'example'
  | 'viewCount'
> & { _id: unknown };

export const SERVABLE_TEMPLATE_FIELDS =
  'listingId slug headline inputs previewImage examplePrompt freeRunEnabled takesFile example viewCount';

/** A published template whose listing the market still serves, or null (the page 404s). */
export async function findServableTemplate(
  slug: string
): Promise<{ template: ServableTemplate; listing: ISkillListing } | null> {
  const template = await SkillListingTemplate.findOne({ slug, status: 'published' })
    .select(SERVABLE_TEMPLATE_FIELDS)
    .lean<ServableTemplate>();
  if (!template) return null;
  const listing = await findListing(template.listingId);
  if (!listing || !isLive(listing)) return null;
  return { template, listing };
}

export interface TemplatePageVisitor {
  userId?: string;
  ip: string;
  userAgent?: string;
}

const VIEW_MARK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The Cache key marking one visitor's view of one page on one UTC day. An HMAC, so the stored key
 * holds no IP or user id and cannot be matched across pages or days without the secret.
 */
export function templateViewMarkKey(templateId: string, visitor: TemplatePageVisitor, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const who = visitor.userId ? `u:${visitor.userId}` : `a:${visitor.ip}|${visitor.userAgent ?? ''}`;
  const digest = createHmac('sha256', Config.JWT_SECRET)
    .update(`skill-template-view:${templateId}:${day}:${who}`)
    .digest('base64url');
  return `skill-template-view:${digest}`;
}

/** Counts a view once per visitor per page per UTC day; true when this request was counted. */
export async function recordTemplateView(
  template: ServableTemplate,
  visitor: TemplatePageVisitor,
  now: Date = new Date()
): Promise<boolean> {
  const key = templateViewMarkKey(String(template._id), visitor, now);
  if (!(await cacheRepository.claimDedup(key, {}, VIEW_MARK_TTL_MS)).claimed) return false;
  await SkillListingTemplate.updateOne({ _id: template._id }, { $inc: { viewCount: 1 } }, { runValidators: true });
  return true;
}

export async function recordTemplateTry(template: ServableTemplate): Promise<void> {
  await SkillListingTemplate.updateOne({ _id: template._id }, { $inc: { tryCount: 1 } }, { runValidators: true });
}

export interface TemplatePageView {
  slug: string;
  skillName: string;
  headline: string;
  inputs: Pick<ISkillTemplateInput, 'label' | 'required'>[];
  /** The listing author's display name; empty falls back to a generic byline. */
  authorName?: string | null;
  /** Null or a zero count renders no rating. */
  rating?: { sum: number; count: number } | null;
  /** Downloads are listing imports. A zero count is left out; both zero renders no line. */
  metrics?: { views: number; downloads: number } | null;
  /** Display names of the connectors the skill needs, e.g. "GitHub". */
  connectors?: string[];
  /** The skill works on a file: the input bar shows a paperclip. */
  takesFile?: boolean;
  /** The stored example run; null keeps the single-column page. */
  example?: TemplatePageExampleView | null;
  /** The `<img src>`; null shows no image. */
  imageSrc: string | null;
  /** 0 renders no starter-credit line. */
  starterCredits: number;
  brandName: string;
  /** Link-preview tags; null for a page that must not unfurl (organization listings). */
  share: { canonicalUrl: string; imageUrl: string | null; siteName: string } | null;
  /** The free-run box, the sign-up prompt that replaces it once the visitor has run, or neither. */
  freeRun?:
    | {
        state: 'open';
        siteKey: string;
        inputMaxChars: number;
        /** The file picker, shown only when the free-run model takes files. */
        file?: { maxBytes: number } | null;
      }
    | { state: 'used' }
    /** The owner preview: the box is drawn but inert, with no script. */
    | { state: 'preview' }
    | null;
}

export const templateTryPath = (slug: string): string => `/skills/market/try/${encodeURIComponent(slug)}`;

const PAGE_STYLE = `
  :root{color-scheme:light dark;--fg:#161b26;--muted:#5b6476;--bg:#ffffff;--card:#ffffff;--line:#e3e7ef;--accent:#3a50d9;--accent-soft:#eef1ff;--accent-fg:#fff;--coral:#d9542f;--coral-soft:#fdeee8;--green:#1f8a5b;--serif:"Newsreader","Iowan Old Style","Charter",Georgia,serif;--sans:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
  @media (prefers-color-scheme: dark){:root{--fg:#e6e9f0;--muted:#9aa3b5;--bg:#151922;--card:#1a1f2b;--line:#2a3142;--accent:#8c9cff;--accent-soft:#232a44;--accent-fg:#151922;--coral:#ff9a76;--coral-soft:#3a2520;--green:#5fd3a0}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.55}
  code,pre,kbd{font-family:var(--mono)}
  main{max-width:calc(44rem + 2 * clamp(20px,6vw,88px));margin:0 auto;padding:clamp(40px,8vw,96px) clamp(20px,6vw,88px)}
  h1{font-family:var(--serif);font-weight:400;letter-spacing:-.02em;font-size:clamp(2.2rem,4.6vw,3.6rem);line-height:1.02;margin:0 0 1rem}
  .byline{color:var(--muted);margin:0 0 1rem}
  .needs{display:flex;align-items:center;gap:.45rem;font-size:.9rem;font-weight:600;margin:0 0 .5rem}
  .needs::before{content:"";flex:none;width:.5rem;height:.5rem;border-radius:50%;background:var(--accent)}
  .lead .cta{margin-top:1rem}
  .preview{display:block;width:100%;height:auto;aspect-ratio:1200/630;object-fit:cover;border-radius:12px;border:1px solid var(--line);background:var(--card);margin:0 0 1.75rem}
  .cta{display:inline-block;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600;padding:.85rem 1.6rem;border-radius:10px}
  .cta:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
  .credits{color:var(--muted);font-size:.9rem;margin:.75rem 0 0}
  .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .run{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:1.5rem;margin:0 0 1.75rem}
  .run label{display:block;font-weight:600;margin:0 0 .5rem}
  .run .file{margin:.75rem 0 0}
  .run .file label{font-weight:400;color:var(--muted);font-size:.9rem;margin:0 0 .3rem}
  .run textarea{width:100%;min-height:8rem;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.6rem;resize:vertical}
  .run .widget{margin:.75rem 0}
  .run button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:.65rem 1.3rem;background:var(--accent);color:var(--accent-fg);cursor:pointer}
  .run button:disabled{opacity:.55;cursor:default}
  .run .status{color:var(--muted);font-size:.9rem;margin:.6rem 0 0;min-height:1.2em}
  .result{border-top:1px solid var(--line);margin:1rem 0 0;padding:1rem 0 0;overflow-x:auto}
  .result table{border-collapse:collapse}
  .result th,.result td{border:1px solid var(--line);padding:.3rem .6rem;text-align:left}
  .result pre{background:var(--bg);padding:.75rem;border-radius:8px;overflow-x:auto}
  .result li:has(> input[type=checkbox]){list-style:none}
  .result .diagram svg{max-width:100%;height:auto}
  [hidden]{display:none !important}
`;

function shareDescription(view: TemplatePageView): string {
  const author = view.authorName?.trim();
  return `Try the /${view.skillName} skill on ${view.brandName}${author ? `, by ${author}` : ''}.`;
}

/** 1234 -> "1.2k", 3_456_789 -> "3.4M". Rounds down, so a count never reads higher than it is. */
export function compactCount(n: number): string {
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) return `${Math.floor((n / size) * 10) / 10}${suffix}`;
  }
  return String(Math.max(0, Math.floor(n)));
}

const countPhrase = (n: number, noun: string): string => `${compactCount(n)} ${noun}${n === 1 ? '' : 's'}`;

function bylineBlock(view: TemplatePageView): string {
  const author = view.authorName?.trim() || 'A Bike4Mind user';
  const rating = view.rating && view.rating.count > 0 ? view.rating : null;
  const stars = rating
    ? ` \u00b7 <span data-testid="template-page-rating">\u2605 ${(rating.sum / rating.count).toFixed(1)} (${rating.count})</span>`
    : '';
  const views = view.metrics?.views ?? 0;
  const downloads = view.metrics?.downloads ?? 0;
  const parts = [
    views > 0 ? countPhrase(views, 'view') : '',
    downloads > 0 ? countPhrase(downloads, 'download') : '',
  ].filter(Boolean);
  const metrics = parts.length ? ` \u00b7 <span data-testid="template-page-metrics">${parts.join(' \u00b7 ')}</span>` : '';
  return `<p class="byline" data-testid="template-page-byline">${escapeHtml(author)}${stars}${metrics}</p>`;
}

function connectorsBlock(connectors: readonly string[] | undefined): string {
  return (connectors ?? [])
    .map(name => `<p class="needs" data-testid="template-page-connector">Needs ${escapeHtml(name)} connected</p>`)
    .join('\n');
}

// Inline script for the free-run box; its CSP hash is TEMPLATE_FREE_RUN_SCRIPT_HASH, so it reads all
// per-page values from data attributes and must stay byte-identical across pages.
const FREE_RUN_SCRIPT = `(function () {
  var box = document.getElementById('free-run');
  if (!box) return;
  var form = document.getElementById('free-run-form');
  var input = document.getElementById('free-run-input');
  var button = document.getElementById('free-run-btn');
  var status = document.getElementById('free-run-status');
  var result = document.getElementById('free-run-result');
  var signup = document.getElementById('free-run-signup');
  var fileInput = document.getElementById('free-run-file');
  var maxBytes = Number(box.getAttribute('data-file-max-bytes')) || 0;
  var token = null;
  var widgetId = null;
  function say(text) { status.textContent = text; }
  function showSignup() { form.hidden = true; signup.hidden = false; }
  function keepInput() { try { localStorage.setItem(box.getAttribute('data-input-key'), input.value.trim()); } catch (e) {} }
  function resetChallenge() { token = null; if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId); }
  function loadScript(src, integrity, onload, onerror) {
    var el = document.createElement('script');
    el.src = src;
    el.async = true;
    if (integrity) { el.integrity = integrity; el.crossOrigin = 'anonymous'; }
    el.onload = onload;
    el.onerror = onerror;
    document.head.appendChild(el);
  }
  loadScript(box.getAttribute('data-turnstile-src'), null, function () {
    widgetId = window.turnstile.render('#free-run-widget', {
      sitekey: box.getAttribute('data-site-key'),
      action: box.getAttribute('data-action'),
      callback: function (value) { token = value; },
      'expired-callback': function () { token = null; },
      'error-callback': function () { token = null; say('The check could not load. Refresh the page to try again.'); }
    });
  }, function () { say('The check could not load. Refresh the page to try again.'); });
  function drawDiagrams() {
    loadScript(box.getAttribute('data-mermaid-src'), box.getAttribute('data-mermaid-integrity'), function () {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      var blocks = result.querySelectorAll('pre > code.language-mermaid');
      Array.prototype.forEach.call(blocks, function (code, i) {
        window.mermaid.render('free-run-diagram-' + i, code.textContent).then(function (out) {
          var div = document.createElement('div');
          div.className = 'diagram';
          div.setAttribute('data-testid', 'template-page-free-run-diagram');
          div.innerHTML = out.svg;
          code.parentNode.replaceWith(div);
        }).catch(function () {});
      });
    }, function () {});
  }
  function pickedFile() {
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) return null;
    if (fileInput.files.length > 1) { say('Attach one file only.'); fileInput.value = ''; return null; }
    var file = fileInput.files[0];
    if (maxBytes && file.size > maxBytes) { say('Attach a file under ' + box.getAttribute('data-file-max-label') + '.'); fileInput.value = ''; return null; }
    return file;
  }
  if (fileInput) fileInput.addEventListener('change', function () { say(''); pickedFile(); });
  function readFile(file, done, failed) {
    if (!file) { done(null); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var url = String(reader.result);
      done({ name: file.name, type: file.type, data: url.slice(url.indexOf(',') + 1) });
    };
    reader.onerror = failed;
    reader.readAsDataURL(file);
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = input.value.trim();
    var file = pickedFile();
    if (!text && !file) { say(fileInput ? 'Paste some text or attach a file first.' : 'Paste some text first.'); return; }
    if (!token) { say('Finish the check above first.'); return; }
    keepInput();
    button.disabled = true;
    say('Running...');
    readFile(file, function (attached) { send(text, attached); }, function () {
      say('The file could not be read. Try another file.');
      button.disabled = false;
    });
  });
  function send(text, attached) {
    var payload = { text: text, turnstileToken: token };
    if (attached) payload.file = attached;
    fetch(box.getAttribute('data-run-url'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      var body = r.body || {};
      if (r.status === 200 && typeof body.html === 'string') {
        result.innerHTML = body.html;
        result.hidden = false;
        say('');
        showSignup();
        if (body.hasDiagram) drawDiagrams();
        return;
      }
      say(body.error || 'The run could not finish. Try again in a moment.');
      if (body.code === 'free_run_used' || body.code === 'free_run_capped') { showSignup(); return; }
      button.disabled = false;
      resetChallenge();
    }).catch(function () {
      say('The run could not finish. Try again in a moment.');
      button.disabled = false;
      resetChallenge();
    });
  }
})();`;

/** The CSP hash that admits the free-run box script. */
export const TEMPLATE_FREE_RUN_SCRIPT_HASH = `'sha256-${createHash('sha256').update(FREE_RUN_SCRIPT).digest('base64')}'`;

export const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
// Pinned with SRI and named by full path in the CSP; loaded only for a result with a diagram.
export const MERMAID_SCRIPT_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js';
const MERMAID_SCRIPT_INTEGRITY = 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2';

/** CSP every template page response starts from (pages/api/skills/template/serve.ts and the owner preview). */
export const TEMPLATE_PAGE_BASE_CSP: readonly string[] = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  // A member render, the preview and example media are signed on the storage origin, which differs per deployment.
  "img-src 'self' data: https:",
  'media-src https:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
];

/**
 * The page's CSP: the example script by hash when it plays, and for a live free-run box its script,
 * the Turnstile widget and, for a diagram, mermaid.
 */
export function templatePageCsp(view: Pick<TemplatePageView, 'freeRun' | 'example'>): string {
  const scripts: string[] = [];
  const extra: string[] = [];
  if (view.freeRun?.state === 'open') {
    scripts.push(TEMPLATE_FREE_RUN_SCRIPT_HASH, TURNSTILE_ORIGIN, MERMAID_SCRIPT_SRC);
    extra.push(`frame-src ${TURNSTILE_ORIGIN}`, "connect-src 'self'");
  }
  if (view.example) scripts.unshift(TEMPLATE_EXAMPLE_SCRIPT_HASH);
  return [...TEMPLATE_PAGE_BASE_CSP, ...(scripts.length ? [`script-src ${scripts.join(' ')}`] : []), ...extra].join(
    '; '
  );
}

/**
 * The preview route's page as the editor frames it in a srcDoc, which never sees response headers:
 * the CSP as a meta tag (frame-ancestors cannot be set that way), and links opening a new context,
 * which the frame's sandbox refuses, so the app never loads inside it.
 */
export function withPreviewFrameGuards(html: string, csp: string): string {
  const policy = csp
    .split('; ')
    .filter(directive => !directive.startsWith('frame-ancestors'))
    .join('; ');
  return html
    .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}">`)
    .replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
}

const freeRunRunPath = (slug: string): string => `/api/skills/template/run/${encodeURIComponent(slug)}`;

function signupBlock(slug: string, brand: string, visible: boolean): string {
  return `<div id="free-run-signup" class="run" data-testid="template-page-free-run-signup"${visible ? '' : ' hidden'}>
<p>Like it? Sign up to keep going with this skill in ${brand}.</p>
<a class="cta" href="${escapeHtml(templateTryPath(slug))}" data-testid="template-page-free-run-signup-btn">Sign up to keep going</a>
</div>`;
}

function fileRow(file: { maxBytes: number } | null | undefined): string {
  if (!file) return '';
  return `<div class="file" data-testid="template-page-free-run-file-row">
<label for="free-run-file">Or attach one file: PDF, image or text, up to ${escapeHtml(formatFileCap(file.maxBytes))}</label>
<input id="free-run-file" type="file" accept="${escapeHtml(FREE_RUN_FILE_ACCEPT)}" data-testid="template-page-free-run-file">
</div>`;
}

const fileCapLabel = (maxBytes: number) => `Attach one file: PDF, image or text, up to ${formatFileCap(maxBytes)}`;

/** The paperclip of the example input bar, wired to the free-run file input. */
function barFileButton(file: { maxBytes: number }): string {
  const label = escapeHtml(fileCapLabel(file.maxBytes));
  return `<span data-testid="template-page-free-run-file-row"><label for="free-run-file" class="ex-clip" title="${label}" data-testid="template-page-example-paperclip">${paperclipIcon()}<span class="sr">${label}</span></label><input id="free-run-file" class="ex-file-input" type="file" accept="${escapeHtml(FREE_RUN_FILE_ACCEPT)}" data-testid="template-page-free-run-file"></span>`;
}

const inputPlaceholder = (view: TemplatePageView): string => view.inputs[0]?.label || 'Message';

function previewRunBlock(view: TemplatePageView, bar: boolean): string {
  const note = 'Visitors can try the skill free here.';
  if (bar) {
    return `<div class="ex-run" data-testid="template-page-free-run-preview">
${renderStaticInputBar({ slug: view.slug, placeholder: inputPlaceholder(view), takesFile: Boolean(view.takesFile) })}
<div class="ex-run-foot"><button type="button" disabled>Try it free</button><p class="status">${note}</p></div>
</div>`;
  }
  return `<div class="run" data-testid="template-page-free-run-preview">
<label for="free-run-preview-input">Try it free</label>
<textarea id="free-run-preview-input" disabled placeholder="Paste your text here"></textarea>
<button type="button" disabled>Try it free</button>
<p class="status">${note}</p>
</div>`;
}

/**
 * The free-run box: a card on the single-column page, or the chat window's input bar (`bar`) when the
 * page shows the example. Both keep the ids FREE_RUN_SCRIPT reads.
 */
function freeRunBlock(view: TemplatePageView, brand: string, bar: boolean): { html: string; script: boolean } {
  const freeRun = view.freeRun;
  if (!freeRun) return { html: '', script: false };
  if (freeRun.state === 'used') {
    const signup = signupBlock(view.slug, brand, true);
    return { html: bar ? `<div class="ex-run">${signup}</div>` : signup, script: false };
  }
  if (freeRun.state === 'preview') return { html: previewRunBlock(view, bar), script: false };
  const file = freeRun.file && (!bar || view.takesFile) ? freeRun.file : null;
  const attrs = [
    ['data-run-url', freeRunRunPath(view.slug)],
    ['data-site-key', freeRun.siteKey],
    ['data-action', TURNSTILE_ACTION_SKILL_FREE_RUN],
    ['data-input-key', skillTemplateFreeRunInputKey(view.slug)],
    ['data-turnstile-src', TURNSTILE_SCRIPT_SRC],
    ['data-mermaid-src', MERMAID_SCRIPT_SRC],
    ['data-mermaid-integrity', MERMAID_SCRIPT_INTEGRITY],
    ...(file
      ? [
          ['data-file-max-bytes', String(file.maxBytes)],
          ['data-file-max-label', formatFileCap(file.maxBytes)],
        ]
      : []),
  ]
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(' ');
  const textarea = (placeholder: string, extra: string) =>
    `<textarea id="free-run-input"${extra} maxlength="${freeRun.inputMaxChars}" placeholder="${escapeHtml(
      placeholder
    )}" data-testid="template-page-free-run-input"></textarea>`;
  const widget = '<div id="free-run-widget" class="widget" data-testid="template-page-free-run-widget"></div>';
  const button =
    '<button id="free-run-btn" type="submit" data-testid="template-page-free-run-btn">Try it free</button>';
  const status =
    '<p id="free-run-status" class="status" role="status" aria-live="polite" data-testid="template-page-free-run-status"></p>';
  const result = '<div id="free-run-result" class="result" hidden data-testid="template-page-free-run-result"></div>';
  if (bar) {
    return {
      script: true,
      html: `<section id="free-run" class="ex-run" ${attrs} data-testid="template-page-free-run">
<form id="free-run-form" data-testid="template-page-free-run-form">
<label for="free-run-input" class="sr">Try it free</label>
<div class="ex-input" data-testid="template-page-example-input">
<span class="ex-skill-chip">${escapeHtml(`/${view.slug}`)}</span>
${textarea(inputPlaceholder(view), ' rows="2"')}
${file ? barFileButton(file) : ''}
</div>
<div class="ex-run-foot">
${widget}
${button}
${status}
</div>
</form>
${result}
${signupBlock(view.slug, brand, false)}
</section>`,
    };
  }
  return {
    script: true,
    html: `<section id="free-run" ${attrs} data-testid="template-page-free-run">
<form id="free-run-form" class="run" data-testid="template-page-free-run-form">
<label for="free-run-input">Try it free</label>
${textarea('Paste your text here', '')}
${fileRow(file)}
${widget}
${button}
${status}
</form>
${result}
${signupBlock(view.slug, brand, false)}
</section>`,
  };
}

export function renderTemplatePage(view: TemplatePageView): string {
  const brand = escapeHtml(view.brandName);
  const name = escapeHtml(view.skillName);
  const headline = escapeHtml(view.headline);
  const example = view.example ?? null;
  const meta = view.share
    ? prepareShareMeta({
        title: view.headline,
        description: shareDescription(view),
        canonicalUrl: view.share.canonicalUrl,
        siteName: view.share.siteName,
        ...(view.share.imageUrl ? { imageUrl: view.share.imageUrl } : {}),
      }).metaTags
    : '';
  const run = freeRunBlock(view, brand, Boolean(example));
  const lead = [
    `<h1 data-testid="template-page-headline">${headline}</h1>`,
    bylineBlock(view),
    connectorsBlock(view.connectors),
  ]
    .filter(Boolean)
    .join('\n');
  const tryButton = `<a class="cta" href="${escapeHtml(templateTryPath(view.slug))}" data-testid="template-page-try-btn">Try with ${brand}</a>`;
  const credits =
    view.starterCredits > 0
      ? `<p class="credits" data-testid="template-page-starter-credits">New accounts start with ${escapeHtml(
          view.starterCredits.toLocaleString('en-US')
        )} free credits.</p>`
      : '';

  let body: string;
  if (example) {
    const inputBar =
      run.html ||
      renderStaticInputBar({
        slug: view.slug,
        placeholder: inputPlaceholder(view),
        takesFile: Boolean(view.takesFile),
      });
    body = `<main class="wide" data-testid="template-page">
<div class="cols">
<div class="lead" data-testid="template-page-lead">
${lead}
${tryButton}
${credits}
</div>
${renderExampleWindow({ example, slug: view.slug, skillName: view.skillName, inputBar })}
</div>
</main>${run.script ? `\n<script>${FREE_RUN_SCRIPT}</script>` : ''}
${exampleScriptTag()}`;
  } else {
    const image = view.imageSrc
      ? `<img class="preview" src="${escapeHtml(view.imageSrc)}" width="1200" height="630" alt="Example result of /${name}" data-testid="template-page-preview-image">`
      : '';
    body = `<main data-testid="template-page">
${lead}
${image}
${run.html}
${tryButton}
${credits}
</main>${run.script ? `\n<script>${FREE_RUN_SCRIPT}</script>` : ''}`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${headline}</title>${meta ? `\n${meta}` : ''}
<style>${PAGE_STYLE}${example ? EXAMPLE_STYLE : ''}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// Same session transport as renderBundleLoaderShell.ts (publish) and app/utils/sessionBootstrap.ts:
// trade the HttpOnly refresh cookie for an access token, then re-fetch this page with it. Keep in sync.
const LOADER_SCRIPT = `(function () {
  var msg = document.getElementById('t-msg');
  function show(html) { msg.innerHTML = html; }
  var loginUrl = '/login?redirectTo=' + encodeURIComponent(location.pathname);
  var token = null;
  var authAttempt = 0;
  var attempt = 0;
  function failed() { show('This page could not be loaded. Try again in a moment.'); }
  function authenticate() {
    authAttempt++;
    fetch('/api/auth/refreshToken', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: '{}' })
      .then(function (res) {
        if (res.status === 200) return res.json();
        if (res.status === 401) { show('Sign in to view this skill page. <a href="' + loginUrl + '">Sign in</a>'); return null; }
        if (authAttempt < 4) { setTimeout(authenticate, authAttempt * 600); return null; }
        failed();
        return null;
      })
      .then(function (data) { if (data && data.accessToken) { token = data.accessToken; load(); } })
      .catch(function () { if (authAttempt < 4) { setTimeout(authenticate, authAttempt * 600); } else { failed(); } });
  }
  function load() {
    attempt++;
    fetch(location.pathname + '?raw=1', { headers: { Authorization: 'Bearer ' + token }, credentials: 'omit' })
      .then(function (res) {
        if (res.status === 200) return res.text();
        if ((res.status === 401 || res.status >= 500) && attempt < 4) { setTimeout(load, attempt * 600); return null; }
        if (res.status === 401) { show('Your session has ended. <a href="' + loginUrl + '">Sign in again</a> to view this skill page.'); return null; }
        if (res.status === 404) { show('This skill page is only available to members of its organization.'); return null; }
        failed();
        return null;
      })
      .then(function (html) { if (html != null) { document.open(); document.write(html); document.close(); } })
      .catch(function () { if (attempt < 4) { setTimeout(load, attempt * 600); } else { failed(); } });
  }
  authenticate();
})();`;

/** The CSP hash that admits the loader script and nothing else. */
export const TEMPLATE_LOADER_SCRIPT_HASH = `'sha256-${createHash('sha256').update(LOADER_SCRIPT).digest('base64')}'`;

/**
 * What a navigation to an organization page gets: a browser navigation carries no credential, so this
 * page signs the visitor in from their session cookie and swaps in the member render. It holds no
 * template data, so a visitor outside the organization learns nothing from it.
 */
export function renderTemplateLoaderShell(slug: string): string {
  const signInHref = escapeHtml(`/login?redirectTo=${encodeURIComponent(skillTemplatePagePath(slug))}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Skill</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main><p id="t-msg" data-testid="template-page-loader">Loading...</p></main>
<noscript><main>Sign in to view this skill page. <a href="${signInHref}">Sign in</a></main></noscript>
<script>${LOADER_SCRIPT}</script>
</body>
</html>`;
}
