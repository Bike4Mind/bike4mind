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

/**
 * (maxChars) => SnapshotResult. A text outline of the page: headings, dialogs, text and every
 * interactive element with a ref - roughly an accessibility tree, in a form a model reads cheaply.
 */
export const SNAPSHOT_PAGE = String.raw`function (maxChars) {
  var ATTR = 'data-b4m-ref';
  var INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],' +
    '[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true]';
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, HEAD: 1 };
  var lines = [];
  var size = 0;
  var truncated = false;
  var next = 1;
  var isJsdom = navigator.userAgent.indexOf('jsdom') !== -1;
  document.querySelectorAll('[' + ATTR + ']').forEach(function (el) {
    var value = Number(el.getAttribute(ATTR));
    if (value >= next) next = value + 1;
  });

  function clean(value) { return (value || '').replace(/\s+/g, ' ').trim(); }
  function visible(el) {
    if (el.closest('[hidden],[aria-hidden=true]')) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (isJsdom) return true;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || style.display === 'contents';
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
      if (text) push(depth, text.slice(0, 300));
      return;
    }
    if (node.nodeType !== 1 || SKIP[node.tagName.toUpperCase()]) return;
    if (!visible(node)) return;
    var i;
    if (node.matches(INTERACTIVE)) {
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
    if (heading) { push(depth, '#'.repeat(Number(heading[1])) + ' ' + clean(node.textContent)); return; }
    if (node.tagName === 'IMG') {
      var alt = clean(node.getAttribute('alt'));
      if (alt) push(depth, 'image ' + JSON.stringify(alt));
      return;
    }
    var role = node.getAttribute('role');
    var landmark = role === 'dialog' || role === 'alertdialog' || role === 'alert' || role === 'status' || node.tagName === 'DIALOG';
    if (landmark) push(depth, '<' + (role || 'dialog') + '>');
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
