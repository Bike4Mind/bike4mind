import { createHash } from 'node:crypto';
import { SkillListingTemplate } from '@bike4mind/database';
import type { ISkillListing, ISkillListingTemplate, ISkillTemplateInput } from '@bike4mind/common';
import { findListing } from '@bike4mind/server-utils/skillMarket/market';
import { escapeHtml } from '@bike4mind/utils/escapeHtml';
import { prepareShareMeta } from '@server/services/publish/prepareShareMeta';
import { isLive } from './template';

/**
 * The public template page at `/t/<slug>` (pages/api/skills/template/serve.ts): static HTML with no
 * script of its own, plus the sign-in loader an organization page is served behind.
 */

export type ServableTemplate = Pick<
  ISkillListingTemplate,
  'listingId' | 'slug' | 'headline' | 'inputs' | 'previewImage' | 'examplePrompt'
> & { _id: unknown };

/** A published template whose listing the market still serves, or null (the page 404s). */
export async function findServableTemplate(
  slug: string
): Promise<{ template: ServableTemplate; listing: ISkillListing } | null> {
  const template = await SkillListingTemplate.findOne({ slug, status: 'published' })
    .select('listingId slug headline inputs previewImage examplePrompt')
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
<a class="cta" href="${escapeHtml(templateTryPath(view.slug))}" data-testid="template-page-try-btn">Try with ${brand}</a>
${credits}
</main>
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
