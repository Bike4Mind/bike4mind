/**
 * Scripts that run INSIDE the page the agent's browser has open. Plain JavaScript source rather
 * than TypeScript functions: the main process has no DOM types, and a bundler may inject helper
 * calls into a function that `toString()` would carry into a page where they do not exist.
 * Covered by pageScripts.test.ts under jsdom.
 *
 * Elements are addressed by a `data-b4m-ref` number the snapshot stamps on them, so the model
 * clicks "ref 12" from the text it just read instead of guessing a CSS selector.
 */

export interface SnapshotResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export type ElementOutcome = { ok: true; description: string } | { ok: false; error: string };

/** A page function's source applied to JSON-safe arguments, as a script for executeJavaScript. */
export function pageCall(source: string, ...args: unknown[]): string {
  return `(${source})(...${JSON.stringify(args)})`;
}

/** What browser_scroll asks for: exactly one of an element ref, a piece of text, or a direction. */
export type ScrollTarget =
  { ref: string } | { text: string } | { direction: 'up' | 'down' | 'top' | 'bottom'; pixels?: number; pages?: number };

/** Declarations shared by the scripts below, spliced into each one's body. */
const PAGE_HELPERS = String.raw`
  var isJsdom = navigator.userAgent.indexOf('jsdom') !== -1;
  function clean(value) { return (value || '').replace(/\s+/g, ' ').trim(); }
  function visible(el) {
    if (el.closest('[hidden],[aria-hidden=true]')) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (isJsdom) return true;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || style.display === 'contents';
  }`;

/**
 * (maxChars, inView?) => SnapshotResult. A text outline of the page: headings, dialogs, text and
 * every interactive element with a ref - roughly an accessibility tree, in a form a model reads
 * cheaply. With inView, only what intersects the viewport, so a scroll shows what it brought
 * into view even on a page whose full outline would be cut off long before it.
 */
export const SNAPSHOT_PAGE = String.raw`function (maxChars, inView) {
  ${PAGE_HELPERS}
  var ATTR = 'data-b4m-ref';
  var INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],' +
    '[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true]';
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, HEAD: 1 };
  var lines = [];
  var size = 0;
  var truncated = false;
  var next = 1;
  document.querySelectorAll('[' + ATTR + ']').forEach(function (el) {
    var value = Number(el.getAttribute(ATTR));
    if (value >= next) next = value + 1;
  });

  // Checked on the lines a snapshot prints rather than on containers, whose children can
  // overflow into view from a box that is itself off screen.
  function shown(el) {
    if (!inView) return true;
    var rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }
  function push(depth, line) {
    if (truncated) return;
    var indented = '  '.repeat(Math.min(depth, 8)) + line;
    if (size + indented.length > maxChars) { truncated = true; return; }
    lines.push(indented);
    size += indented.length + 1;
  }
  function textOf(el) { return clean(el.innerText !== undefined && !isJsdom ? el.innerText : el.textContent); }
  function labelOf(el) {
    var aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var joined = labelledBy.split(/\s+/).map(function (id) {
        var target = document.getElementById(id);
        return target ? clean(target.textContent) : '';
      }).join(' ').trim();
      if (joined) return joined;
    }
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      var byFor = el.id ? Array.prototype.find.call(document.getElementsByTagName('label'), function (l) {
        return l.htmlFor === el.id;
      }) : null;
      var label = clean((byFor || el.closest('label') || {}).textContent);
      if (label) return label;
      if (el.placeholder) return clean(el.placeholder);
      return clean(el.getAttribute('name'));
    }
    return textOf(el).slice(0, 120) || clean(el.getAttribute('title'));
  }
  function describe(el) {
    var tag = el.tagName;
    var parts = [];
    if (tag === 'INPUT') {
      var type = el.type || 'text';
      var toggle = type === 'checkbox' || type === 'radio';
      parts.push(toggle ? type : 'input[' + type + ']', JSON.stringify(labelOf(el)));
      if (toggle) parts.push(el.checked ? 'checked' : 'unchecked');
      else if (type !== 'password' && el.value) parts.push('value=' + JSON.stringify(el.value.slice(0, 80)));
    } else if (tag === 'TEXTAREA') {
      parts.push('textarea', JSON.stringify(labelOf(el)));
      if (el.value) parts.push('value=' + JSON.stringify(el.value.slice(0, 80)));
    } else if (tag === 'SELECT') {
      parts.push('select', JSON.stringify(labelOf(el)));
      var selected = el.selectedOptions && el.selectedOptions[0];
      if (selected) parts.push('selected=' + JSON.stringify(clean(selected.textContent)));
      var options = Array.prototype.slice.call(el.options, 0, 12).map(function (o) { return clean(o.textContent); });
      parts.push('options=' + JSON.stringify(options));
    } else if (tag === 'A') {
      parts.push('link', JSON.stringify(labelOf(el)), '-> ' + el.getAttribute('href'));
    } else {
      parts.push(el.getAttribute('role') || tag.toLowerCase(), JSON.stringify(labelOf(el)));
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    return parts.join(' ');
  }
  function walk(node, depth) {
    if (truncated) return;
    if (node.nodeType === 3) {
      var text = clean(node.textContent);
      if (text && shown(node.parentElement)) push(depth, text.slice(0, 300));
      return;
    }
    if (node.nodeType !== 1 || SKIP[node.tagName.toUpperCase()]) return;
    if (!visible(node)) return;
    var i;
    if (node.matches(INTERACTIVE)) {
      if (!shown(node)) return;
      var ref = node.getAttribute(ATTR);
      if (!ref) { ref = String(next++); node.setAttribute(ATTR, ref); }
      push(depth, '[' + ref + '] ' + describe(node));
      // A button's, link's or select's own text is already in its description.
      if (node.tagName !== 'SELECT' && node.tagName !== 'BUTTON' && node.tagName !== 'A') {
        for (i = 0; i < node.childNodes.length; i++) {
          if (node.childNodes[i].nodeType !== 3) walk(node.childNodes[i], depth + 1);
        }
      }
      return;
    }
    var heading = /^H([1-6])$/.exec(node.tagName);
    if (heading) {
      if (shown(node)) push(depth, '#'.repeat(Number(heading[1])) + ' ' + clean(node.textContent));
      return;
    }
    if (node.tagName === 'IMG') {
      var alt = clean(node.getAttribute('alt'));
      if (alt && shown(node)) push(depth, 'image ' + JSON.stringify(alt));
      return;
    }
    var role = node.getAttribute('role');
    var landmark = role === 'dialog' || role === 'alertdialog' || role === 'alert' || role === 'status' || node.tagName === 'DIALOG';
    if (landmark && shown(node)) push(depth, '<' + (role || 'dialog') + '>');
    for (i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], landmark ? depth + 1 : depth);
  }

  walk(document.body || document.documentElement, 0);
  return { url: location.href, title: document.title, text: lines.join('\n'), truncated: truncated };
}`;

/** (ref) => ElementOutcome. Scroll the element into view and click it the way a user's click lands. */
export const CLICK_REF = String.raw`function (ref) {
  var el = document.querySelector('[data-b4m-ref="' + ref + '"]');
  if (!el) return { ok: false, error: 'No element with ref ' + ref + ' on this page. Take a new snapshot.' };
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
  var init = { bubbles: true, cancelable: true, composed: true };
  var Pointer = window.PointerEvent || window.MouseEvent;
  el.dispatchEvent(new Pointer('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  if (el.focus) el.focus();
  el.dispatchEvent(new Pointer('pointerup', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.click();
  var name = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.tagName.toLowerCase());
  return { ok: true, description: name.replace(/\s+/g, ' ').trim().slice(0, 80) };
}`;

/**
 * (ref, text) => ElementOutcome. Fill an input, textarea, select or editable region. Goes through
 * the native value setter so a React-controlled input sees the change instead of snapping back.
 */
export const FILL_REF = String.raw`function (ref, text) {
  var el = document.querySelector('[data-b4m-ref="' + ref + '"]');
  if (!el) return { ok: false, error: 'No element with ref ' + ref + ' on this page. Take a new snapshot.' };
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  if (el.focus) el.focus();
  function fire() {
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  function setValue(proto, value) {
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value); else el.value = value;
  }
  if (el.tagName === 'SELECT') {
    var option = Array.prototype.find.call(el.options, function (o) {
      return o.value === text || (o.textContent || '').trim() === text;
    });
    if (!option) return { ok: false, error: 'The select has no option ' + JSON.stringify(text) + '.' };
    setValue(HTMLSelectElement.prototype, option.value);
    fire();
    return { ok: true, description: 'selected ' + JSON.stringify((option.textContent || '').trim()) };
  }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    setValue(el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, text);
    fire();
    return { ok: true, description: el.type === 'password' ? 'filled a password field' : 'filled ' + JSON.stringify(text.slice(0, 80)) };
  }
  if (el.isContentEditable) {
    el.textContent = text;
    fire();
    return { ok: true, description: 'filled an editable region' };
  }
  return { ok: false, error: 'Ref ' + ref + ' is a ' + el.tagName.toLowerCase() + ', which does not take text.' };
}`;

/**
 * (target: ScrollTarget) => ElementOutcome.
 *
 * An element is brought to the middle of the view with scrollIntoView, which also scrolls every
 * inner container it sits in. A direction scrolls the nearest container under the middle of the
 * view that can still move that way, the way a wheel's scroll chains outwards - so an app that
 * scrolls a panel rather than the document still scrolls. 'instant' because a page's own
 * `scroll-behavior: smooth` would otherwise still be animating when the snapshot is read.
 */
export const SCROLL_PAGE = String.raw`function (target) {
  ${PAGE_HELPERS}
  var AGAIN = '; take a browser_snapshot for current refs.';

  function nameOf(el) {
    var name = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
    return name.slice(0, 80) || el.tagName.toLowerCase();
  }
  function bringIntoView(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return { ok: true, description: nameOf(el) };
  }
  // One pass over the visible text, joined, so a match split across inline tags - as in
  // "<b>Total</b> due" - is found too; the element is the one holding all of the match.
  function findText(want) {
    var root = document.body || document.documentElement;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var joined = '';
    var starts = [];
    var nodes = [];
    var lastParent = null;
    var parentShown = false;
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var parent = node.parentElement;
      if (!parent) continue;
      if (parent !== lastParent) {
        lastParent = parent;
        parentShown = !parent.closest('script,style,noscript,template') && visible(parent);
      }
      if (!parentShown) continue;
      var piece = node.textContent.replace(/\s+/g, ' ').toLowerCase();
      if (piece.charAt(0) === ' ' && (joined === '' || joined.charAt(joined.length - 1) === ' ')) piece = piece.slice(1);
      if (!piece) continue;
      starts.push(joined.length);
      nodes.push(node);
      joined += piece;
    }
    var at = joined.indexOf(want);
    if (!want || at === -1) return null;
    function nodeAt(offset) {
      var i = 0;
      while (i + 1 < starts.length && starts[i + 1] <= offset) i++;
      return nodes[i];
    }
    var last = nodeAt(at + want.length - 1);
    var el = nodeAt(at).parentElement;
    while (!el.contains(last)) el = el.parentElement;
    return el;
  }

  if (target.ref !== undefined) {
    var byRef = document.querySelector('[data-b4m-ref="' + target.ref + '"]');
    if (!byRef) return { ok: false, error: 'No element matched ref ' + target.ref + AGAIN };
    return bringIntoView(byRef);
  }
  if (target.text !== undefined) {
    var byText = findText(clean(target.text).toLowerCase());
    if (!byText) return { ok: false, error: 'No visible element matched text ' + JSON.stringify(target.text) + AGAIN };
    return bringIntoView(byText);
  }

  var direction = target.direction;
  var forward = direction === 'down' || direction === 'bottom';
  var page = document.scrollingElement || document.documentElement;
  function range(el) { return el.scrollHeight - el.clientHeight; }
  function scrolls(el) {
    if (range(el) <= 1) return false;
    if (el === page) return true;
    var overflow = window.getComputedStyle(el).overflowY;
    return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  }
  function canMove(el) { return forward ? el.scrollTop < range(el) - 1 : el.scrollTop > 0; }

  var chain = [];
  var middle = document.elementFromPoint ? document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) : null;
  for (var at = middle; at && at !== page; at = at.parentElement) if (scrolls(at)) chain.push(at);
  if (scrolls(page)) chain.push(page);
  if (chain.length === 0) {
    // Nothing scrolls under the middle of the view, as when an overlay covers it: the largest
    // scrolling panel on the page is the likeliest main content.
    var largest = null;
    var area = 0;
    document.querySelectorAll('body *').forEach(function (el) {
      if (!scrolls(el) || !visible(el)) return;
      var size = el.clientWidth * el.clientHeight;
      if (size > area) { largest = el; area = size; }
    });
    if (largest) chain.push(largest);
  }
  if (chain.length === 0) return { ok: false, error: 'Nothing on this page scrolls: all of it is already in view.' };

  var scroller = chain.find(canMove) || chain[0];
  var where = scroller === page ? 'the page' : 'the scrollable ' + scroller.tagName.toLowerCase() +
    (scroller.getAttribute('aria-label') ? ' ' + JSON.stringify(clean(scroller.getAttribute('aria-label'))) : '');
  var edge = forward ? 'bottom' : 'top';
  if (!canMove(scroller)) return { ok: true, description: 'Already at the ' + edge + ' of ' + where + '; nothing moved.' };

  var before = scroller.scrollTop;
  var step = target.pixels || Math.round((target.pages || 1) * scroller.clientHeight * 0.9);
  var to = direction === 'top' ? 0 : direction === 'bottom' ? range(scroller) :
    Math.max(0, Math.min(range(scroller), before + (forward ? step : -step)));
  if (scroller.scrollTo) scroller.scrollTo({ top: to, behavior: 'instant' }); else scroller.scrollTop = to;
  var moved = Math.round(Math.abs(scroller.scrollTop - before));
  var position = ' (now ' + Math.round(scroller.scrollTop) + 'px of ' + Math.round(range(scroller)) + 'px)';
  var lead = direction === 'top' || direction === 'bottom' ? 'Scrolled to the ' + edge + ' of ' + where :
    'Scrolled ' + direction + ' ' + moved + 'px in ' + where;
  return { ok: true, description: lead + position + '.' };
}`;
