import { createHash } from 'node:crypto';
import { SkillListingTemplate } from '@bike4mind/database';
import {
  TURNSTILE_ACTION_SKILL_FREE_RUN,
  skillTemplateFreeRunInputKey,
  type ISkillListing,
  type ISkillListingTemplate,
  type ISkillTemplateInput,
} from '@bike4mind/common';
import { findListing } from '@bike4mind/server-utils/skillMarket/market';
import { escapeHtml } from '@bike4mind/utils/escapeHtml';
import { prepareShareMeta } from '@server/services/publish/prepareShareMeta';
import { isLive } from './template';

/**
 * The public template page at `/t/<slug>` (pages/api/skills/template/serve.ts): static HTML whose only
 * script is the free-run box's, plus the sign-in loader an organization page is served behind.
 */

export type ServableTemplate = Pick<
  ISkillListingTemplate,
  'listingId' | 'slug' | 'headline' | 'inputs' | 'previewImage' | 'examplePrompt' | 'freeRunEnabled'
> & { _id: unknown };

/** A published template whose listing the market still serves, or null (the page 404s). */
export async function findServableTemplate(
  slug: string
): Promise<{ template: ServableTemplate; listing: ISkillListing } | null> {
  const template = await SkillListingTemplate.findOne({ slug, status: 'published' })
    .select('listingId slug headline inputs previewImage examplePrompt freeRunEnabled')
    .lean<ServableTemplate>();
  if (!template) return null;
  const listing = await findListing(template.listingId);
  if (!listing || !isLive(listing)) return null;
  return { template, listing };
}

export async function recordTemplateView(template: ServableTemplate): Promise<void> {
  await SkillListingTemplate.updateOne({ _id: template._id }, { $inc: { viewCount: 1 } }, { runValidators: true });
}

export async function recordTemplateTry(template: ServableTemplate): Promise<void> {
  await SkillListingTemplate.updateOne({ _id: template._id }, { $inc: { tryCount: 1 } }, { runValidators: true });
}

export interface TemplatePageView {
  slug: string;
  skillName: string;
  headline: string;
  inputs: Pick<ISkillTemplateInput, 'label' | 'required'>[];
  /** The `<img src>`; null shows no image. */
  imageSrc: string | null;
  /** 0 renders no starter-credit line. */
  starterCredits: number;
  brandName: string;
  /** Link-preview tags; null for a page that must not unfurl (organization listings). */
  share: { canonicalUrl: string; imageUrl: string | null; siteName: string } | null;
  /** The free-run box, the sign-up prompt that replaces it once the visitor has run, or neither. */
  freeRun?: { state: 'open'; siteKey: string; inputMaxChars: number } | { state: 'used' } | null;
}

export const templateTryPath = (slug: string): string => `/skills/market/try/${encodeURIComponent(slug)}`;

const PAGE_STYLE = `
  :root{color-scheme:light dark;--fg:#1a1a2e;--muted:#5b5b70;--bg:#f7f7fb;--card:#fff;--line:#d6d6e2;--accent:#4f46e5;--accent-fg:#fff}
  @media (prefers-color-scheme: dark){:root{--fg:#e6e6f0;--muted:#a0a0b8;--bg:#0f0f1a;--card:#1a1a2b;--line:#34344a;--accent:#8b85ff;--accent-fg:#0f0f1a}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
  main{max-width:44rem;margin:0 auto;padding:3rem 1rem 4rem}
  .badge{display:inline-block;font-size:.85rem;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:.2rem .75rem;margin:0 0 1rem}
  .badge code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}
  h1{font-size:clamp(1.6rem,4vw,2.25rem);line-height:1.2;margin:0 0 1.5rem}
  h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 .5rem}
  .chips{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1.75rem;padding:0;list-style:none}
  .chip{border:1.5px solid var(--fg);border-radius:999px;padding:.25rem .8rem;font-size:.95rem}
  .chip.optional{border-style:dashed;color:var(--muted);border-color:var(--muted)}
  .preview{display:block;width:100%;height:auto;aspect-ratio:1200/630;object-fit:cover;border-radius:12px;border:1px solid var(--line);background:var(--card);margin:0 0 1.75rem}
  .cta{display:inline-block;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600;padding:.75rem 1.4rem;border-radius:10px}
  .cta:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
  .credits{color:var(--muted);font-size:.9rem;margin:.75rem 0 0}
  .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .run{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:1.25rem;margin:0 0 1.75rem}
  .run label{display:block;font-weight:600;margin:0 0 .5rem}
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

function inputsBlock(inputs: TemplatePageView['inputs']): string {
  if (inputs.length === 0) return '';
  const chips = inputs
    .map(
      input =>
        `<li class="chip${input.required ? '' : ' optional'}" data-testid="template-page-input-chip" data-required="${
          input.required ? 'true' : 'false'
        }">${escapeHtml(input.label)}${input.required ? '' : '<span class="sr"> (optional)</span>'}</li>`
    )
    .join('');
  return `<h2>You bring</h2>\n<ul class="chips" data-testid="template-page-inputs">${chips}</ul>`;
}

function shareDescription(view: TemplatePageView): string {
  const bring = view.inputs.map(input => (input.required ? input.label : `${input.label} (optional)`)).join(', ');
  return `${view.brandName} skill /${view.skillName}.${bring ? ` You bring: ${bring}.` : ''}`;
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
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) { say('Paste some text first.'); return; }
    if (!token) { say('Finish the check above first.'); return; }
    keepInput();
    button.disabled = true;
    say('Running...');
    fetch(box.getAttribute('data-run-url'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: text, turnstileToken: token })
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
  });
})();`;

/** The CSP hash that admits the free-run box script. */
export const TEMPLATE_FREE_RUN_SCRIPT_HASH = `'sha256-${createHash('sha256').update(FREE_RUN_SCRIPT).digest('base64')}'`;

export const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
// Pinned with SRI and named by full path in the CSP; loaded only for a result with a diagram.
export const MERMAID_SCRIPT_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js';
const MERMAID_SCRIPT_INTEGRITY = 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2';

const freeRunRunPath = (slug: string): string => `/api/skills/template/run/${encodeURIComponent(slug)}`;

function signupBlock(slug: string, brand: string, visible: boolean): string {
  return `<div id="free-run-signup" class="run" data-testid="template-page-free-run-signup"${visible ? '' : ' hidden'}>
<p>Like it? Sign up to keep going with this skill in ${brand}.</p>
<a class="cta" href="${escapeHtml(templateTryPath(slug))}" data-testid="template-page-free-run-signup-btn">Sign up to keep going</a>
</div>`;
}

function freeRunBlock(view: TemplatePageView, brand: string): { html: string; script: boolean } {
  const freeRun = view.freeRun;
  if (!freeRun) return { html: '', script: false };
  if (freeRun.state === 'used') return { html: signupBlock(view.slug, brand, true), script: false };
  const attrs = [
    ['data-run-url', freeRunRunPath(view.slug)],
    ['data-site-key', freeRun.siteKey],
    ['data-action', TURNSTILE_ACTION_SKILL_FREE_RUN],
    ['data-input-key', skillTemplateFreeRunInputKey(view.slug)],
    ['data-turnstile-src', TURNSTILE_SCRIPT_SRC],
    ['data-mermaid-src', MERMAID_SCRIPT_SRC],
    ['data-mermaid-integrity', MERMAID_SCRIPT_INTEGRITY],
  ]
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(' ');
  return {
    script: true,
    html: `<section id="free-run" ${attrs} data-testid="template-page-free-run">
<form id="free-run-form" class="run" data-testid="template-page-free-run-form">
<label for="free-run-input">Try it free</label>
<textarea id="free-run-input" maxlength="${freeRun.inputMaxChars}" placeholder="Paste your text here" data-testid="template-page-free-run-input"></textarea>
<div id="free-run-widget" class="widget" data-testid="template-page-free-run-widget"></div>
<button id="free-run-btn" type="submit" data-testid="template-page-free-run-btn">Try it free</button>
<p id="free-run-status" class="status" role="status" aria-live="polite" data-testid="template-page-free-run-status"></p>
</form>
<div id="free-run-result" class="result" hidden data-testid="template-page-free-run-result"></div>
${signupBlock(view.slug, brand, false)}
</section>`,
  };
}

export function renderTemplatePage(view: TemplatePageView): string {
  const brand = escapeHtml(view.brandName);
  const name = escapeHtml(view.skillName);
  const headline = escapeHtml(view.headline);
  const meta = view.share
    ? prepareShareMeta({
        title: view.headline,
        description: shareDescription(view),
        canonicalUrl: view.share.canonicalUrl,
        siteName: view.share.siteName,
        ...(view.share.imageUrl ? { imageUrl: view.share.imageUrl } : {}),
      }).metaTags
    : '';
  const image = view.imageSrc
    ? `<img class="preview" src="${escapeHtml(view.imageSrc)}" width="1200" height="630" alt="Example result of /${name}" data-testid="template-page-preview-image">`
    : '';
  const run = freeRunBlock(view, brand);
  const credits =
    view.starterCredits > 0
      ? `<p class="credits" data-testid="template-page-starter-credits">New accounts start with ${escapeHtml(
          view.starterCredits.toLocaleString('en-US')
        )} free credits.</p>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${headline}</title>${meta ? `\n${meta}` : ''}
<style>${PAGE_STYLE}</style>
</head>
<body>
<main data-testid="template-page">
<p class="badge" data-testid="template-page-badge">${brand} skill <code>/${name}</code></p>
<h1 data-testid="template-page-headline">${headline}</h1>
${inputsBlock(view.inputs)}
${image}
${run.html}
<a class="cta" href="${escapeHtml(templateTryPath(view.slug))}" data-testid="template-page-try-btn">Try with ${brand}</a>
${credits}
</main>${run.script ? `\n<script>${FREE_RUN_SCRIPT}</script>` : ''}
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
export function renderTemplateLoaderShell(): string {
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
<noscript><main>Sign in to view this skill page. <a href="/login">Sign in</a></main></noscript>
<script>${LOADER_SCRIPT}</script>
</body>
</html>`;
}
