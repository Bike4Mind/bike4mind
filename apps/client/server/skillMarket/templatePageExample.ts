import { createHash } from 'node:crypto';
import { escapeHtml } from '@bike4mind/utils/escapeHtml';

/**
 * The example run on a template page (templatePage.ts): a chat window replaying a stored run of the
 * skill. The HTML is the final state, so no-JS and reduced-motion visitors see it whole; the script
 * only hides and re-reveals it to animate.
 */

export interface TemplatePageExampleView {
  prompt: string;
  /** Sanitized HTML of the (trimmed) reply. */
  replyHtml: string;
  steps: { label: string; simulated: boolean }[];
  /** Sanitized, static artifact HTML. */
  artifact: { title: string; html: string } | null;
  /** `src` is a short-lived signed URL. */
  media: {
    kind: 'video' | 'image' | 'carousel';
    items: { src: string; mime: string; width?: number; height?: number }[];
  } | null;
  sampleFile: { name: string; mime: string; pages?: number } | null;
}

// Reveal pause after each thread item, in ms; read by the script from `data-ex-step`.
const PAUSE = { user: 700, tool: 550, used: 500, reply: 800, chip: 450 } as const;

export const EXAMPLE_STYLE = `
  main.wide{max-width:calc(80rem + 2 * clamp(20px,6vw,88px));min-height:100svh;box-sizing:border-box;display:grid;align-content:center}
  .cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4rem;align-items:center}
  .ex-win{border:1px solid var(--line);border-radius:14px;background:var(--card);overflow:hidden;display:flex;flex-direction:column;box-shadow:0 12px 32px rgba(0,0,0,.08)}
  .ex-bar{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.9rem 1.25rem;border-bottom:1px solid var(--line);font-size:.85rem;font-weight:600;color:var(--muted)}
  .ex-bar button,.ex-panel-bar button{font:inherit;font-size:.8rem;color:var(--fg);background:transparent;border:1px solid var(--line);border-radius:8px;padding:.2rem .6rem;cursor:pointer;align-items:center;gap:.3rem}
  .ex-stage{position:relative}
  .ex-live .ex-stage{height:36rem}
  .ex-thread{height:auto;max-height:30rem;overflow-y:auto;padding:1.25rem;display:flex;flex-direction:column;gap:.8rem}
  .ex-user{align-self:flex-end;max-width:85%;display:flex;flex-direction:column;align-items:flex-end;gap:.4rem}
  .ex-bubble{background:var(--bg);border:1px solid var(--line);border-radius:14px 14px 4px 14px;padding:.55rem .8rem;white-space:pre-wrap;word-break:break-word}
  .ex-file{display:flex;align-items:center;gap:.6rem;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:.45rem .7rem;max-width:100%}
  .ex-file-icon{flex:none;font-size:.7rem;font-weight:700;color:var(--accent-fg);background:var(--accent);border-radius:6px;padding:.3rem .4rem}
  .ex-file-name{display:block;font-weight:600;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ex-file-meta{display:block;font-size:.75rem;color:var(--muted)}
  .ex-skill-chip{display:inline-flex;align-items:center;border-radius:999px;padding:.05rem .55rem;font-size:.8rem;font-weight:600;line-height:1.5;background:var(--accent-soft);color:var(--accent);font-family:var(--mono);margin-right:.35rem;white-space:nowrap}
  .ex-tool{display:flex;align-items:center;gap:.45rem;margin:0;font-size:.8rem;color:var(--muted)}
  .ex-tool::before{content:"";flex:none;width:.4rem;height:.4rem;border-radius:50%;background:var(--accent)}
  .ex-sim{font-size:.7rem;border:1px solid var(--line);border-radius:999px;padding:0 .45rem}
  .ex-used{margin:0;font-size:.75rem;color:var(--muted)}
  .ex-used strong{font-size:.875rem;font-weight:600;color:var(--fg)}
  .ex-reply{overflow-x:auto;border-left:2px solid var(--coral);padding-left:.9rem}
  .ex-reply > :first-child{margin-top:0}
  .ex-reply table,.ex-doc table{border-collapse:collapse}
  .ex-reply th,.ex-reply td,.ex-doc th,.ex-doc td{border:1px solid var(--line);padding:.3rem .6rem;text-align:left}
  .ex-reply pre,.ex-doc pre{background:var(--bg);padding:.75rem;border-radius:8px;overflow-x:auto}
  .ex-art-chip{align-self:flex-start;display:inline-flex;align-items:center;gap:.5rem;font:inherit;font-size:.85rem;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:.45rem .75rem;cursor:pointer}
  .ex-art-chip svg{color:var(--accent)}
  .ex-panel{display:flex;flex-direction:column;background:var(--card);border-top:1px solid var(--line);max-height:34rem}
  .ex-live .ex-thread{height:100%;max-height:none}
  .ex-live .ex-panel{position:absolute;top:0;right:0;bottom:0;width:88%;max-height:none;border-top:0;border-left:1px solid var(--line);box-shadow:-12px 0 24px rgba(0,0,0,.12);transition:transform .45s ease,visibility .45s}
  .ex-live .ex-panel:not(.open){transform:translateX(102%);visibility:hidden}
  .ex-panel-bar{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.75rem 1.25rem;border-bottom:1px solid var(--line);font-size:.85rem;font-weight:600}
  .ex-panel-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ex-doc{flex:1;overflow:auto;padding:1.25rem}
  .ex-doc > :first-child{margin-top:0}
  .ex-video{display:block;width:100%;max-width:20rem;aspect-ratio:9/16;margin:0 auto;background:#000;border-radius:10px;object-fit:cover}
  .ex-image{margin:0}
  .ex-image img{display:block;max-width:100%;height:auto;margin:0 auto;border-radius:10px}
  .ex-slides{display:flex;gap:.5rem;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;margin:0}
  .ex-slide{flex:0 0 100%;scroll-snap-align:center;margin:0}
  .ex-slide img{display:block;width:100%;height:auto;border-radius:10px}
  .ex-input{display:flex;align-items:center;gap:.5rem;border-top:1px solid var(--line);padding:.9rem 1.25rem}
  .ex-placeholder{flex:1;min-width:0;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ex-clip{flex:none;display:inline-flex;color:var(--muted);cursor:pointer}
  .ex-run{border-top:1px solid var(--line)}
  .ex-run .ex-input{border-top:0}
  .ex-run textarea{flex:1;min-width:0;min-height:2.6rem;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.45rem .6rem;resize:vertical}
  .ex-run-foot{padding:0 1.25rem 1rem}
  .ex-run-foot .widget{margin:0 0 .6rem}
  .ex-run-foot button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:.55rem 1.2rem;background:var(--accent);color:var(--accent-fg);cursor:pointer}
  .ex-run-foot button:disabled{opacity:.55;cursor:default}
  .ex-run-foot .status{color:var(--muted);font-size:.9rem;margin:.5rem 0 0;min-height:1.2em}
  .ex-run .result{margin:0 1.25rem;padding:1rem 0}
  .ex-run .run{margin:.75rem 1.25rem}
  .ex-file-input{position:absolute;width:1px;height:1px;opacity:0}
  .ex-js{display:none !important}
  .ex-live .ex-js:not([hidden]){display:inline-flex !important}
  .ex-pending{display:none !important}
  .ex-in{animation:ex-in .35s ease both}
  @keyframes ex-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @media (max-width: 880px){
    .cols{grid-template-columns:minmax(0,1fr)}
    .ex-live .ex-stage{height:auto}
    .ex-live .ex-thread{height:auto;max-height:30rem}
    .ex-live .ex-panel{position:static;width:auto;transform:none;transition:none;border-left:0;border-top:1px solid var(--line);box-shadow:none;max-height:34rem}
    .ex-live .ex-panel:not(.open){display:none}
  }
  @media (prefers-reduced-motion: reduce){
    .ex-live .ex-panel{transition:none}
    .ex-in{animation:none}
  }
`;

// Inline script for the example; its CSP hash is TEMPLATE_EXAMPLE_SCRIPT_HASH, so it reads everything
// from the DOM and must stay byte-identical across pages.
const EXAMPLE_SCRIPT = `(function () {
  var root = document.getElementById('example');
  if (!root) return;
  var panel = document.getElementById('example-panel');
  var chip = document.getElementById('example-artifact-chip');
  var closeBtn = document.getElementById('example-panel-close');
  var replay = document.getElementById('example-replay');
  var thread = document.getElementById('example-thread');
  var timers = [];
  root.classList.add('ex-live');
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function setOpen(open) {
    if (!panel) return;
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (chip) chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    var video = panel.querySelector('video');
    if (video && !open) video.pause();
  }
  if (chip) chip.addEventListener('click', function () { setOpen(true); });
  if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function show(el) {
    el.classList.remove('ex-pending');
    el.classList.add('ex-in');
    if (thread && thread.contains(el)) thread.scrollTop = thread.scrollHeight;
  }
  function hide(el) { el.classList.remove('ex-in'); el.classList.add('ex-pending'); }
  function play() {
    each(timers, clearTimeout);
    timers = [];
    var steps = root.querySelectorAll('[data-ex-step]');
    var blocks = panel ? panel.querySelectorAll('[data-ex-blocks] > *') : [];
    each(steps, hide);
    each(blocks, hide);
    setOpen(false);
    if (thread) thread.scrollTop = 0;
    var t = 300;
    each(steps, function (el) {
      later(t, function () { show(el); });
      t += Number(el.getAttribute('data-ex-step')) || 500;
    });
    if (!panel) return;
    later(t, function () {
      setOpen(true);
      var video = panel.querySelector('video');
      if (video) { video.currentTime = 0; var p = video.play(); if (p && p.catch) p.catch(function () {}); }
    });
    t += 450;
    each(blocks, function (el) { later(t, function () { show(el); }); t += 220; });
  }
  if (replay) { replay.hidden = false; replay.addEventListener('click', play); }
  play();
})();`;

/** The CSP hash that admits the example script. */
export const TEMPLATE_EXAMPLE_SCRIPT_HASH = `'sha256-${createHash('sha256').update(EXAMPLE_SCRIPT).digest('base64')}'`;

export const exampleScriptTag = (): string => `<script>${EXAMPLE_SCRIPT}</script>`;

const ICON_PAPERCLIP =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>';
const ICON_DOC =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const ICON_REPLAY =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';

export const paperclipIcon = (): string => ICON_PAPERCLIP;

/** A short type label for a file card: PDF, Image, Text, or the subtype. */
export function fileTypeLabel(mime: string): string {
  const bare = mime.split(';')[0].trim().toLowerCase();
  if (bare === 'application/pdf') return 'PDF';
  if (bare.startsWith('image/')) return 'Image';
  if (bare === 'text/markdown') return 'Markdown';
  if (bare === 'text/csv') return 'CSV';
  if (bare.startsWith('text/')) return 'Text';
  const sub = bare.slice(bare.indexOf('/') + 1).replace(/^(vnd\.|x-)/, '');
  return sub ? sub.slice(0, 12).toUpperCase() : 'File';
}

function fileCard(file: NonNullable<TemplatePageExampleView['sampleFile']>): string {
  const type = fileTypeLabel(file.mime);
  const pages = file.pages && file.pages > 0 ? ` \u00b7 ${file.pages} ${file.pages === 1 ? 'page' : 'pages'}` : '';
  return `<div class="ex-file" data-testid="template-page-example-file">
<span class="ex-file-icon">${escapeHtml(type.slice(0, 4).toUpperCase())}</span>
<span><span class="ex-file-name">${escapeHtml(file.name)}</span><span class="ex-file-meta">${escapeHtml(type)}${pages}</span></span>
</div>`;
}

const dims = (item: { width?: number; height?: number }): string =>
  item.width && item.height ? ` width="${Math.round(item.width)}" height="${Math.round(item.height)}"` : '';

function mediaBlock(media: NonNullable<TemplatePageExampleView['media']>, skillName: string): string {
  const alt = escapeHtml(`Example result of /${skillName}`);
  if (media.kind === 'video') {
    const item = media.items[0];
    return `<video class="ex-video" src="${escapeHtml(item.src)}" muted playsinline controls preload="metadata" data-testid="template-page-example-video"></video>`;
  }
  if (media.kind === 'image') {
    const item = media.items[0];
    return `<figure class="ex-image" data-testid="template-page-example-image"><img src="${escapeHtml(item.src)}"${dims(item)} alt="${alt}"></figure>`;
  }
  const slides = media.items
    .map(
      (item, i) =>
        `<figure class="ex-slide"><img src="${escapeHtml(item.src)}"${dims(item)} alt="${alt}, slide ${i + 1} of ${media.items.length}" loading="lazy"></figure>`
    )
    .join('');
  return `<div class="ex-slides" role="region" aria-label="Example slides" tabindex="0" data-testid="template-page-example-carousel">${slides}</div>`;
}

/**
 * The right column: the chat window. `inputBar` is the free-run box or the static input bar, already
 * rendered by the caller.
 */
export function renderExampleWindow(args: {
  example: TemplatePageExampleView;
  slug: string;
  skillName: string;
  inputBar: string;
}): string {
  const { example, slug, skillName, inputBar } = args;
  const chipLabel = escapeHtml(`/${slug}`);
  const steps = example.steps
    .map(
      step =>
        `<p class="ex-tool" data-ex-step="${PAUSE.tool}" data-testid="template-page-example-step">${escapeHtml(step.label)}${
          step.simulated ? ' <span class="ex-sim" data-testid="template-page-example-simulated">simulated</span>' : ''
        }</p>`
    )
    .join('\n');
  const hasPanel = Boolean(example.artifact || example.media);
  const panelTitle = escapeHtml(example.artifact?.title || 'Result');
  const artChip = hasPanel
    ? `<button type="button" id="example-artifact-chip" class="ex-art-chip" aria-controls="example-panel" aria-expanded="true" data-ex-step="${PAUSE.chip}" data-testid="template-page-example-artifact-chip">${ICON_DOC}<span>${panelTitle}</span></button>`
    : '';
  const panel = hasPanel
    ? `<aside id="example-panel" class="ex-panel open" aria-label="${panelTitle}" data-testid="template-page-example-panel">
<div class="ex-panel-bar"><span class="ex-panel-title">${panelTitle}</span><button type="button" id="example-panel-close" class="ex-js" aria-label="Close" data-testid="template-page-example-panel-close">x</button></div>
<div class="ex-doc" data-ex-blocks>${example.media ? mediaBlock(example.media, skillName) : ''}${example.artifact?.html ?? ''}</div>
</aside>`
    : '';
  return `<section id="example" class="ex" aria-label="Example run" data-testid="template-page-example">
<div class="ex-win">
<div class="ex-bar"><span>Example</span><button type="button" id="example-replay" class="ex-js" hidden data-testid="template-page-example-replay">${ICON_REPLAY}Replay</button></div>
<div class="ex-stage">
<div id="example-thread" class="ex-thread">
<div class="ex-user" data-ex-step="${PAUSE.user}" data-testid="template-page-example-user">
${example.sampleFile ? fileCard(example.sampleFile) : ''}
<div class="ex-bubble"><span class="ex-skill-chip" data-testid="template-page-example-skill-chip">${chipLabel}</span>${escapeHtml(example.prompt)}</div>
</div>
${steps}
<p class="ex-used" data-ex-step="${PAUSE.used}" data-testid="template-page-example-used-skill">Used skill <strong>${escapeHtml(skillName)}</strong></p>
<div class="ex-reply" data-ex-step="${PAUSE.reply}" data-testid="template-page-example-reply">${example.replyHtml}</div>
${artChip}
</div>
${panel}
</div>
${inputBar}
</div>
</section>`;
}

/** The input bar when there is no live free-run box: skill chip, first input label, paperclip. */
export function renderStaticInputBar(args: { slug: string; placeholder: string; takesFile: boolean }): string {
  return `<div class="ex-input" data-testid="template-page-example-input">
<span class="ex-skill-chip">${escapeHtml(`/${args.slug}`)}</span>
<span class="ex-placeholder">${escapeHtml(args.placeholder)}</span>
${args.takesFile ? `<span class="ex-clip" data-testid="template-page-example-paperclip">${ICON_PAPERCLIP}</span>` : ''}
</div>`;
}
