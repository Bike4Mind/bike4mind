import { describe, it, expect } from 'vitest';
import { detectElidedContent } from './artifactElision';
import { parseArtifacts } from './artifactParser';

/**
 * The negative cases below carry the weight of this suite. Detection fires an advisory
 * banner on the user's artifact, so a heuristic that cries wolf on complete work is worse
 * than one that occasionally misses - every "should NOT flag" test is guarding shippability.
 */

/** Verbatim shape of the artifact from the originating bug report: correct data, stubbed behaviour. */
const REAL_ELIDED_BODY = `<!DOCTYPE html>
<html>
<head><style>body { font-family: system-ui; }</style></head>
<body>
  <div id="board"></div>
  <script>
    const RANKS = [{ name: 'Alpha', score: 91 }, { name: 'Beta', score: 88 }];

    // Search, filter, sort, rail, chips, counts, intel sections (identical to previous complete version)
    // ... (same JS as the working artifact for interactivity)

    function init() {
      renderBoard();
      // All the interactive JS from the previous complete artifact
      // (search, sort, chips, rail, counts, intel sections)
      // for brevity, the core data is now correctly populated with 2027 ranks.
    }
    init();
  </script>
</body>
</html>`;

const COMPLETE_HTML = `<!DOCTYPE html>
<html>
<head><style>.card { padding: 8px; }</style></head>
<body>
  <input id="q" />
  <div id="board"></div>
  <script>
    const RANKS = [{ name: 'Alpha', score: 91 }, { name: 'Beta', score: 88 }];

    function renderBoard(rows) {
      const board = document.getElementById('board');
      board.textContent = '';
      rows.forEach(row => {
        const el = document.createElement('div');
        el.className = 'card';
        el.textContent = row.name + ': ' + row.score;
        board.appendChild(el);
      });
    }

    function applySearch(term) {
      return RANKS.filter(r => r.name.toLowerCase().includes(term.toLowerCase()));
    }

    function init() {
      renderBoard(RANKS);
      document.getElementById('q').addEventListener('input', e => {
        renderBoard(applySearch(e.target.value));
      });
    }
    init();
  </script>
</body>
</html>`;

const COMPLETE_REACT = `import { LineChart, Line, XAxis } from 'recharts';
import { Search } from 'lucide-react';

const DATA = [{ x: 1, y: 4 }, { x: 2, y: 9 }];

function formatLabel(point) {
  return \`\${point.x}: \${point.y}\`;
}

export default function Dashboard() {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => DATA.filter(d => formatLabel(d).includes(query)), [query]);
  const onChange = event => setQuery(event.target.value);

  return (
    <div style={{ padding: 16 }}>
      <Search size={16} />
      <input value={query} onChange={onChange} />
      <LineChart width={640} height={360} data={filtered}>
        <XAxis dataKey="x" />
        <Line dataKey="y" />
      </LineChart>
    </div>
  );
}`;

/**
 * Reported from manual testing against a preview build: an artifact that is structurally complete -
 * closes `</html>`, every function genuinely implemented, search and render both real - whose DATA
 * is omitted behind marker comments. It published with no warning at all, because the phrase list
 * matched the bare `for brevity` and its own padded variant `for the sake of brevity` sitting two
 * lines away went unmatched.
 */
const ELIDED_DATA_BODY = `<!DOCTYPE html>
<html>
<head><title>Programming Languages Dashboard (100 Languages)</title>
<style>.row { padding: 4px; }</style></head>
<body>
  <h1>Explore 100 programming languages</h1>
  <input id="q" />
  <div id="rows"></div>
  <script>
    const LANGS = [
      { name: 'Python', paradigm: 'multi' },
      { name: 'JavaScript', paradigm: 'multi' },
      // ... For the sake of brevity and manageable artifact size, I will include the remaining 84 languages as unique, but concise.
      // Due to system limits, please respond "CONTINUE" and I will immediately send the remaining entries.
    ];

    function renderRows(rows) {
      const host = document.getElementById('rows');
      host.textContent = '';
      rows.forEach(row => {
        const el = document.createElement('div');
        el.className = 'row';
        el.textContent = row.name + ' (' + row.paradigm + ')';
        host.appendChild(el);
      });
    }

    function applySearch(term) {
      return LANGS.filter(l => l.name.toLowerCase().includes(term.toLowerCase()));
    }

    function init() {
      renderRows(LANGS);
      document.getElementById('q').addEventListener('input', e => renderRows(applySearch(e.target.value)));
    }
    init();
  </script>
</body>
</html>`;

describe('detectElidedContent', () => {
  describe('elided data behind a marker comment', () => {
    it('flags an otherwise-working artifact whose records are omitted', () => {
      const result = detectElidedContent(ELIDED_DATA_BODY, 'html');

      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('catches it on the comment signal alone, with no hollow body or phantom call to lean on', () => {
      // The point of the specimen: every function is real and every call resolves, so the phrase
      // list is the only thing standing between this artifact and an ungated publish.
      const result = detectElidedContent(ELIDED_DATA_BODY, 'html');

      expect(result.signals.every(s => s.kind === 'placeholder_comment')).toBe(true);
    });

    it.each([
      ['padded brevity', '// For the sake of brevity, the other entries follow the same shape'],
      ['brevity, other padding', '// omitting these in the interest of brevity'],
      ['reader asked to reply', '// Due to system limits, please respond "CONTINUE" and I will send the rest'],
      ['pointer at a later turn', '// see next response for the remaining rows'],
      ['first-person promise', '// I will include the remaining 84 languages below'],
      ['claimed-but-absent count', '// The following 90 languages are all individually defined'],
    ])('flags %s', (_label, comment) => {
      const body = `<html><body><script>\n${comment}\nfunction go() { document.title = 'x'; }\ngo();\n</script></body></html>`;

      expect(detectElidedContent(body, 'html').confidence).toBe('high');
    });

    it.each([
      ['a prose TODO in the first person', '// I will add validation later, once the schema settles'],
      ['a remaining-count in its ordinary sense', '// the remaining 3 bytes are padding'],
      ['pagination that mentions a next response', '// in the next response we get the cursor'],
      ['waiting on a response', '// wait for the next response before retrying'],
      ['a hyphenated path segment', '//cdn.example.com/for-brevity-notes.js'],
    ])('does not flag %s', (_label, comment) => {
      const body = `<html><body><script>\n${comment}\nfunction go() { document.title = 'x'; }\ngo();\n</script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });
  });

  describe('the reported failure', () => {
    it('flags the real elided artifact with high confidence', () => {
      const result = detectElidedContent(REAL_ELIDED_BODY, 'html');

      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('high');
      expect(result.signals.filter(s => s.kind === 'placeholder_comment').length).toBeGreaterThanOrEqual(3);
    });

    it('also catches the stubbed behaviour through the undefined-reference signal', () => {
      const result = detectElidedContent(REAL_ELIDED_BODY, 'html');

      expect(result.signals).toContainEqual({ kind: 'undefined_reference', name: 'renderBoard' });
    });

    it('reports the line number of each placeholder comment', () => {
      const result = detectElidedContent(REAL_ELIDED_BODY, 'html');
      const placeholders = result.signals.filter(s => s.kind === 'placeholder_comment');

      for (const signal of placeholders) {
        expect(signal.kind === 'placeholder_comment' && signal.line).toBeGreaterThan(0);
      }
    });
  });

  describe('complete artifacts are never flagged', () => {
    it('does not flag a complete interactive HTML artifact', () => {
      expect(detectElidedContent(COMPLETE_HTML, 'html')).toEqual({
        elided: false,
        confidence: 'low',
        signals: [],
      });
    });

    it('does not flag a complete React artifact (pre-injected hooks, imports, params all resolve)', () => {
      expect(detectElidedContent(COMPLETE_REACT, 'react')).toEqual({
        elided: false,
        confidence: 'low',
        signals: [],
      });
    });

    it('does not flag an empty or whitespace body', () => {
      expect(detectElidedContent('', 'html').elided).toBe(false);
      expect(detectElidedContent('   \n  ', 'html').elided).toBe(false);
    });
  });

  describe('comment anchoring (the false-positive guard)', () => {
    it('does not flag stub phrases that appear in visible prose', () => {
      const body = `<html><body>
        <h1>Release notes</h1>
        <p>The changelog below is abbreviated for brevity; the rest of the entries are omitted.</p>
        <p>Section 3 is unchanged and identical to previous versions.</p>
      </body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    // The cases below pin the lexer. An earlier version scanned for comments with a separate,
    // line-by-line matcher that had no string or template state, so an artifact that merely
    // DISPLAYED code containing a stub phrase flagged at HIGH confidence. Comments are now
    // harvested by the same single pass that blanks strings and templates, and HTML is walked
    // tag-aware so an attribute value is never treated as code.
    it('does not flag a comment-shaped stub phrase inside a template literal', () => {
      const body = `<html><body><script>
        const tpl = \`<div><!-- rest of the rows are rendered below --></div>\`;
        function render() { document.body.innerHTML = tpl; }
        render();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('does not flag a block comment inside a string showing sample code', () => {
      const body = `<html><body><script>
        const SAMPLE = 'function f() { /* for brevity */ }';
        function show() { document.title = SAMPLE; }
        show();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('does not let an unterminated /* inside a string swallow the next line', () => {
      const body = `<html><body><script>
        const DOC = 'use /* to open a block comment';
        const NOTE = 'identical to previous builds';
        function go() { document.title = DOC + NOTE; }
        go();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('does not let an apostrophe in HTML prose hide a later real stub comment', () => {
      // Markup is not JS: a quote in body text is an apostrophe, not a string delimiter. Lexing
      // this with JS rules opened a "string" that ran past the stub comment entirely.
      const body = `<html><body>
        <p>it's a lovely day</p>
        <!-- rest of the markup omitted for brevity -->
      </body></html>`;

      const result = detectElidedContent(body, 'html');
      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('does not scan a quoted attribute value as a comment', () => {
      // The fixture must contain REAL HTML-comment syntax inside the attribute, or the test passes
      // whether or not attributes are skipped: `//` is never a comment marker to the HTML walker, so
      // an earlier `src="//cdn..."` fixture proved nothing. Neutering skipHtmlTag makes this fail.
      const body = `<html><body>
        <div title="<!-- rest of the sections omitted -->">Legend</div>
        <script src="//cdn.example.com/lib.js"></script>
        <script>function go(){ document.title='x'; } go();</script>
      </body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('still flags a real HTML comment sitting right after a tag with attributes', () => {
      // The other side of the same guard: skipping attributes must not skip past a following comment.
      const body = `<html><body>
        <div title="Legend" data-x="1">Legend</div>
        <!-- rest of the sections omitted -->
      </body></html>`;

      expect(detectElidedContent(body, 'html').confidence).toBe('high');
    });

    it('flags a stub phrase in a CSS block comment', () => {
      const body = `<html><head><style>
        .card { color: #333; }
        /* rest of the rules omitted for brevity */
      </style></head><body><div class="card">x</div></body></html>`;

      expect(detectElidedContent(body, 'html').confidence).toBe('high');
    });

    it('treats a python docstring as prose but still flags a # stub', () => {
      const clean = `def run():\n    """for brevity we only summarise here"""\n    return 1\n`;
      const stub = `def run():\n    # rest of the implementation omitted for brevity\n    pass\n`;

      expect(detectElidedContent(clean, 'python').elided).toBe(false);
      expect(detectElidedContent(stub, 'python').confidence).toBe('high');
    });

    it('does not mislex a regex literal after a keyword as division', () => {
      // `return /re/` read as division left the regex body as live code, leaking phantom names.
      const body = `<html><body><script>
        function isNum(s) { return /^[0-9]+$/.test(s); }
        function go() { document.title = isNum('1') ? 'y' : 'n'; }
        go();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('does not flag "rest of the" in its ordinary sense', () => {
      // This was the one unqualified phrase in an otherwise carefully qualified list, so it fired at
      // HIGH confidence on healthy code. Now qualified like its omitted/unchanged siblings.
      const body = `<html><body><script>
        function drain(queue) {
          const first = queue.shift();
          // handle the rest of the items in the queue
          queue.forEach(item => log(item));
          return first;
        }
        function log(i) { return i; }
        drain([1, 2, 3]);
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('still flags the stub reading of "rest of the"', () => {
      const body = '<html><body><!-- rest of the markup unchanged --><div id="a"></div></body></html>';

      expect(detectElidedContent(body, 'html').confidence).toBe('high');
    });

    it('does not flag a working CDN-library page whose globals it cannot know', () => {
      // A jQuery page reaches the 2-distinct-name threshold on `$` and `jQuery` alone; a p5.js
      // sketch flags on four. An off-site script means the global namespace is unknowable, so the
      // reference signals carry no information and are suppressed rather than merely re-thresholded.
      const jquery = `<html><body>
        <script src="https://cdn.example.com/jquery.min.js"></script>
        <script>
          $(document).ready(function () { jQuery('#app').text('ready'); });
        </script>
      </body></html>`;
      const p5 = `<html><body>
        <script src="//cdn.example.com/p5.min.js"></script>
        <script>
          function setup() { createCanvas(400, 400); background(220); }
          function draw() { ellipse(mouseX, mouseY, 20, 20); fill(100); }
        </script>
      </body></html>`;

      expect(detectElidedContent(jquery, 'html').elided).toBe(false);
      expect(detectElidedContent(p5, 'html').elided).toBe(false);
    });

    it('still flags a stub comment on a page that loads a CDN library', () => {
      // Suppression applies ONLY to the reference signals - the high-confidence ones must survive,
      // or loading a library would become a way to hide an elided artifact entirely.
      const body = `<html><body>
        <script src="https://cdn.example.com/jquery.min.js"></script>
        <script>
          function init() {
            // All the interactive JS from the previous complete artifact
          }
          init();
        </script>
      </body></html>`;

      expect(detectElidedContent(body, 'html').confidence).toBe('high');
    });

    it('does not suppress references for a root-relative blessed library', () => {
      // Root-relative sources are the self-hosted blessed libraries, whose globals ARE known, so
      // suppression must not extend to them or every artifact could opt out of the scan.
      const body = `<html><body>
        <script src="/libs/chart.umd.min.js"></script>
        <script>
          function init() { renderBoard(); wireChips(); }
          init();
        </script>
      </body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(true);
    });

    it('does not flag stub phrases inside string literals', () => {
      const body = `<html><body><script>
        const NOTICE = 'for brevity, see the appendix';
        function render() { document.title = NOTICE; }
        render();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('does not read a bare protocol-relative URL as a line comment', () => {
      // At column 0 there is no preceding ':' to catch, so the host pattern is what saves it.
      const body = `<html><body>
        <script src="//cdn.example.com/lib.js"></script>
        <script>
//cdn.example.com/for-brevity-notes.js
          function render() { document.title = 'ok'; }
          render();
        </script>
      </body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('reads a bare // line inside a script as the JS comment it is', () => {
      // This replaces a test that described a host-matching regex which no longer exists. Both of its
      // fixtures also passed only because their paths were hyphenated (`for-brevity-notes.js` does
      // not match `for brevity`), so neither half proved anything. Inside a <script> body a bare
      // `//host/path` line IS a JS line comment - reading it as one is correct - and the phrase in it
      // must still be matched.
      const stubPhrase = `<html><body><script>
//cdn.example.com/x.js - rest of the code omitted
        function render() { document.title = 'ok'; }
        render();
      </script></body></html>`;
      const innocent = `<html><body><script>
//cdn.example.com/vendor.js
        function render() { document.title = 'ok'; }
        render();
      </script></body></html>`;

      expect(detectElidedContent(stubPhrase, 'html').confidence).toBe('high');
      expect(detectElidedContent(innocent, 'html').elided).toBe(false);
    });

    it('does not flag "from the previous" in its ordinary sense', () => {
      const body = `<html><body><script>
        function render() {
          // Ported from the previous system, kept for parity
          document.title = 'ok';
        }
        render();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('flags the exact phrase the prompt forbids: "from the previous complete version"', () => {
      // The prompt's NEVER ABBREVIATE list names this wording, so the detector has to cover it. The
      // qualifier requirement is what keeps `// Ported from the previous system` out, tested below.
      const body = '<html><body><!-- markup from the previous complete version --><div></div></body></html>';

      expect(detectElidedContent(body, 'html').confidence).toBe('high');
    });

    it('still flags the stub reading of "from the previous"', () => {
      const body = '<html><body><!-- markup copied from the previous version --><div></div></body></html>';

      expect(detectElidedContent(body, 'html').confidence).toBe('high');
    });

    it('does not read a URL as a line comment', () => {
      const body = `<html><body><script>
        const DOCS = 'https://example.com/docs';
        function open_() { window.open(DOCS); }
        open_();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('flags a stub phrase in an HTML comment', () => {
      const body = '<html><body><!-- rest of the sections omitted --><div id="a"></div></body></html>';

      const result = detectElidedContent(body, 'html');
      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('flags a stub phrase in a block comment spanning lines', () => {
      const body = `<html><body><script>
        /*
         * Chart setup is identical to previous
         * complete version.
         */
        document.title = 'x';
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').confidence).toBe('high');
    });

    it('does not flag "omitted" or "unchanged" in their ordinary code-comment senses', () => {
      const body = `<html><body><script>
        function render(props) {
          // props unchanged, skip re-render
          // optional fields omitted from the payload are defaulted server-side
          document.title = props.title;
        }
        render({ title: 'ok' });
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('still flags the stub readings of the same two words', () => {
      const omitted = '<html><body><!-- the rest of the sections omitted --><div></div></body></html>';
      const unchanged = '<html><body><!-- markup unchanged from the previous version --><div></div></body></html>';

      expect(detectElidedContent(omitted, 'html').confidence).toBe('high');
      expect(detectElidedContent(unchanged, 'html').confidence).toBe('high');
    });

    it('treats # as a comment marker only for python artifacts', () => {
      const python = "# rest of the implementation omitted\nprint('hi')";
      const css = '<html><head><style>.a { color: #unchanged; }</style></head></html>';

      expect(detectElidedContent(python, 'python').elided).toBe(true);
      expect(detectElidedContent(css, 'html').elided).toBe(false);
    });
  });

  describe('undefined references', () => {
    it('needs two distinct undefined names before firing, and reports low confidence', () => {
      const one = `<html><body><script>
        function init() { renderBoard(); }
        init();
      </script></body></html>`;
      const two = `<html><body><script>
        function init() { renderBoard(); wireChips(); }
        init();
      </script></body></html>`;

      expect(detectElidedContent(one, 'html').elided).toBe(false);
      const result = detectElidedContent(two, 'html');
      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('low');
    });

    it('sees names bound by NESTED destructuring', () => {
      // A comma split on the captured group produced the fragment `user: { name`, so `name` was
      // never registered as declared - two such names called bare would then fire.
      const body = `<html><body><script>
        const CONFIG = { user: { name: () => 'a', email: () => 'b' } };
        const { user: { name, email } } = CONFIG;
        function render() { document.title = name() + email(); }
        render();
      </script></body></html>`;

      const result = detectElidedContent(body, 'html');
      const missing = result.signals.filter(s => s.kind === 'undefined_reference').map(s => s.name);

      expect(missing).not.toContain('name');
      expect(missing).not.toContain('email');
      expect(result.elided).toBe(false);
    });

    it('does not treat `new Ctor()` as a bare call to an undefined function', () => {
      // `new` is a call-like keyword but the identifier AFTER it was still collected, so two
      // constructors for classes we do not list as ambient reached the two-distinct-names threshold.
      const body = `<html><body><script>
        function init() {
          const obs = new IntersectionObserver(() => {});
          const fmt = new Intl.NumberFormat('en-US');
          const chart = new ChartWidget(document.body);
          const store = new SessionStore();
          obs.observe(document.body);
          document.title = fmt.format(1) + chart.id + store.id;
        }
        init();
      </script></body></html>`;

      const result = detectElidedContent(body, 'html');
      const missing = result.signals.filter(s => s.kind === 'undefined_reference').map(s => s.name);

      expect(missing).not.toContain('ChartWidget');
      expect(missing).not.toContain('SessionStore');
      expect(result.elided).toBe(false);
    });

    it('does not flag member calls, which it cannot resolve', () => {
      const body = `<html><body><script>
        const api = { load() { return 1; }, save() { return 2; } };
        function init() { api.load(); api.save(); window.scrollTo(0, 0); }
        init();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('flags an inline handler calling a function that was never defined', () => {
      const body = `<html><body>
        <button onclick="exportCsv()">Export</button>
        <button onclick="resetFilters()">Reset</button>
        <script>function init() { document.title = 'x'; } init();</script>
      </body></html>`;

      const result = detectElidedContent(body, 'html');
      expect(result.elided).toBe(true);
      expect(result.signals).toContainEqual({
        kind: 'undefined_handler',
        name: 'exportCsv',
        attribute: 'onclick',
      });
    });

    it('does not flag an inline handler whose function is defined in the script', () => {
      const body = `<html><body>
        <button onclick="exportCsv()">Export</button>
        <button onclick="resetFilters()">Reset</button>
        <script>
          function exportCsv() { return 1; }
          function resetFilters() { return 2; }
        </script>
      </body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });
  });

  describe('type gating', () => {
    it('skips the JS scan for code artifacts, whose language is unknown at this layer', () => {
      const goish = `package main
func main() {
  renderBoard()
  wireChips()
}`;

      expect(detectElidedContent(goish, 'code').elided).toBe(false);
    });

    it('still comment-scans non-JS types', () => {
      const svg = '<svg viewBox="0 0 10 10"><!-- illustration goes here --></svg>';

      expect(detectElidedContent(svg, 'svg').elided).toBe(true);
    });

    it('does not run the JS scan when no type is supplied', () => {
      const body = 'function init() { renderBoard(); wireChips(); } init();';

      expect(detectElidedContent(body).elided).toBe(false);
    });
  });

  /**
   * The hollowed-skeleton variant, captured from a live staging session on 2026-07-27. The model
   * kept every function declaration and replaced each body with a DESCRIPTIVE comment. Neither
   * of the original two signals sees it: the comments say what the code would do rather than
   * referring to a previous version, and every called name resolves because the declaration is
   * still present. Only the missing bodies give it away.
   */
  // Two hollow bodies used to be silent regardless of what their comments said, so a model could
  // ship a dead artifact by describing the behaviour instead of writing it. QA caught this on the
  // preview twice. The discriminator is what the comment DOES: declare the emptiness deliberate, or
  // describe behaviour that was never implemented.
  describe('hollow bodies: described stub vs declared no-op', () => {
    it('flags QA repro 1 - two bodies that describe what they would do', () => {
      const body = `<html><body>
        <button id="go">Run</button>
        <div id="out"></div>
        <script>
          function init() {
            // Wire up the button and render the list
          }
          function render() {
            // Render all rows into #out
          }
          init();
        </script>
      </body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(true);
    });

    it('flags QA repro 2 - working logic vouching for two described stubs', () => {
      // The artifact's honest half is what makes this dangerous: the counter reports "5 of 5 tasks
      // shown" while the columns render empty, so visual review reads it as working.
      const body = `<html><body>
        <input id="q" placeholder="Filter">
        <div id="count"></div>
        <div id="cols"></div>
        <button id="add">Add</button>
        <script>
          const TASKS = [
            { id: 1, title: 'A', status: 'todo' },
            { id: 2, title: 'B', status: 'doing' },
            { id: 3, title: 'C', status: 'done' }
          ];
          let filter = '';
          function visibleTasks() {
            return TASKS.filter(t => t.title.toLowerCase().includes(filter.toLowerCase()));
          }
          function updateCount() {
            document.getElementById('count').textContent = visibleTasks().length + ' of ' + TASKS.length;
          }
          function renderBoard() {
            // This function would clear each column and display the filtered tasks in their columns.
          }
          function addTask() {
            // This function would gather input, create a task, add it to TASKS and refresh the board.
          }
          document.getElementById('add').addEventListener('click', addTask);
          updateCount();
          renderBoard();
        </script>
      </body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(true);
    });

    it('does NOT report a single described body', () => {
      // Pins the reportable threshold FROM BELOW, which nothing did: setting HOLLOW_BODY_REPORTABLE to
      // 1 previously left the whole suite green. One hollow body is an ordinary shape - a handler
      // someone has not filled in yet - and must only corroborate, never fire alone. The last two
      // commits before this moved exactly this constant, and only its upper edge was pinned.
      const body = `<html><body><script>
        function alpha() {
          // Render every row into the table
        }
        function beta() {
          document.title = 'ok';
          return 1;
        }
        function go() { alpha(); beta(); }
        go();
      </script></body></html>`;

      const result = detectElidedContent(body, 'html');
      expect(result.signals.filter(s => s.kind === 'empty_function_body')).toHaveLength(1);
      expect(result.elided).toBe(false);
    });

    it('reports two described bodies at LOW confidence, three at HIGH', () => {
      const two = `<html><body><script>
        function init() { // Attach every event listener
        }
        function render() { // Draw all the rows
        }
        init();
      </script></body></html>`;
      const three = `<html><body><script>
        function init() { // Attach every event listener
        }
        function render() { // Draw all the rows
        }
        function refresh() { // Recompute totals and redraw
        }
        init();
      </script></body></html>`;

      expect(detectElidedContent(two, 'html').confidence).toBe('low');
      expect(detectElidedContent(three, 'html').confidence).toBe('high');
    });

    it('stays silent on bodies that DECLARE themselves deliberate', () => {
      // The requirement from the opposite direction: an ordinary no-op must not warn, however many
      // of them there are. This is the case a prior review asked us to protect.
      const body = `<html><body><script>
        function onResize() {
          // intentionally does nothing - layout is handled entirely in CSS
        }
        function onPrint() {
          // no-op, reserved for the print hook
        }
        function onIdle() {
          // deliberately empty by design
        }
        function render() { document.title = 'ok'; onResize(); onPrint(); onIdle(); }
        render();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    // These fixtures are NOT drawn from the no-op vocabulary. An earlier version of this file defined
    // "describes behaviour" as "does not match a short list of no-op phrasings", and every negative
    // fixture here was taken from that same list - so the suite could not see that every phrasing
    // MISSING from the list was a false positive on healthy code. All five below flagged before the
    // check was inverted to require positive evidence of described behaviour.
    it.each([
      [
        'a comment pointing at where the work actually happens',
        '// Handled by CSS media queries',
        '// Swallow; the retry loop already reports',
      ],
      ['the plainest possible no-op declaration', '// Nothing to do here', '// Nothing to do here'],
      ['an abstract hook meant for subclasses', '// subclasses override this', '// subclasses override this'],
      [
        'comments explaining why nothing happens here',
        '// silenced in production builds',
        '// sent by the host page, not here',
      ],
      ['bare TODO, which names no behaviour', '// todo', '// fixme'],
    ])('stays silent on %s', (_label, first, second) => {
      const body = `<html><body><script>
        function alpha() { ${first}
        }
        function beta() { ${second}
        }
        function go() { alpha(); beta(); document.title = 'x'; }
        go();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('lets an explicit no-op declaration override a behaviour verb', () => {
      // Positive evidence is necessary but not sufficient: a comment can name a verb and still be
      // declaring the absence deliberate.
      const body = `<html><body><script>
        function alpha() {
          // intentionally does not render anything - the host page owns this region
        }
        function beta() {
          // deliberately skips the update; the poller refreshes it instead
        }
        function go() { alpha(); beta(); document.title = 'x'; }
        go();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('flags the "it would do X" construction even without a listed verb', () => {
      const body = `<html><body><script>
        function alpha() {
          // This function would reconcile the two lists and mark the differences
        }
        function beta() {
          // This would then notify every subscriber about the change
        }
        function go() { alpha(); beta(); document.title = 'x'; }
        go();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(true);
    });

    it('does not count a body with no comment at all', () => {
      // A stub explains itself; a bare `{}` is a no-op. Two of them must not warn.
      const body = `<html><body><script>
        function onResize() {}
        function onPrint() {}
        function render() { document.title = 'ok'; onResize(); onPrint(); }
        render();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });
  });

  describe('hollowed bodies across declaration forms', () => {
    it('flags hollow arrow-const handlers in a react artifact', () => {
      // The `function` keyword alone was not enough: react artifacts overwhelmingly use
      // `const handleX = () => {}`, so this exact shape - the reported bug, in the framework the
      // detector most often runs in - previously produced ZERO signals.
      const body = `
        const handleSearch = () => { // wire up search
        };
        const handleFilter = () => { // wire up filtering
        };
        const handleSort = () => { // wire up sorting
        };
        const handleExport = () => { // wire up export
        };
        function App() { return <div onClick={handleSearch}>x</div>; }
      `;

      const result = detectElidedContent(body, 'react');
      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('flags a hollow arrow assigned to a property, not just to window', () => {
      // `el.onclick = () => {}` is the commonest vanilla-JS handler shape in these artifacts, and the
      // pattern previously special-cased only `window.`, so every one of them was invisible.
      const body = `<html><body>
        <button id="a">A</button><button id="b">B</button>
        <script>
          document.getElementById('a').onclick = () => {
            // Render the detail panel for the selected row
          };
          document.getElementById('b').onclick = () => {
            // Export the current selection as CSV
          };
        </script>
      </body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(true);
    });

    it('flags hollow object method shorthand', () => {
      const body = `<html><body><script>
        const api = {
          load() { // fetch it
          },
          save() { // persist it
          },
          reset() { // clear it
          },
        };
        function go(){ api.load(); api.save(); api.reset(); }
        go();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').confidence).toBe('high');
    });

    it('counts a function declaration once, not once per matching form', () => {
      // `function foo() {}` matches both the declaration pattern and the method-shorthand pattern, so
      // without dedupe these TWO functions would count as FOUR. Asserted on the signal list rather
      // than on `elided`, because bare `// todo` names no behaviour and is silent either way - the
      // count is what this test exists to pin.
      const body = `<html><body><script>
        function a() { // todo
        }
        function b() { // todo
        }
        function go() { a(); b(); document.title='x'; }
        go();
      </script></body></html>`;

      const result = detectElidedContent(body, 'html');
      expect(result.signals.filter(s => s.kind === 'empty_function_body')).toHaveLength(2);
      expect(result.elided).toBe(false);
    });

    it('does not double-count when dedupe would push it over the HIGH threshold', () => {
      // The dedupe assertion above cannot fail loudly on its own, so this pins the consequence: two
      // DESCRIBED bodies must report LOW, and would report HIGH if each were counted twice.
      const body = `<html><body><script>
        function a() { // Render every row into the table
        }
        function b() { // Attach the click handlers
        }
        function go() { a(); b(); document.title='x'; }
        go();
      </script></body></html>`;

      const result = detectElidedContent(body, 'html');
      expect(result.signals.filter(s => s.kind === 'empty_function_body')).toHaveLength(2);
      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('low');
    });

    it('does not treat control flow or an empty constructor as a hollow body', () => {
      // Every block here carries a DESCRIBED comment, so without the keyword/constructor exclusions
      // these would register as hollow bodies. An earlier version of this test used comment-less
      // blocks, which made it pass whether the exclusions existed or not.
      const body = `<html><body><script>
        class Thing {
          constructor() { // Build the thing
          }
        }
        function go(items) {
          if (!items.length) { // Render the empty state
          }
          for (const i of items) { // Draw each row
          }
          try { document.title = 'x'; } catch (e) { // Report the failure
          }
          return new Thing();
        }
        go([]);
      </script></body></html>`;

      const result = detectElidedContent(body, 'html');
      expect(result.signals.filter(s => s.kind === 'empty_function_body')).toHaveLength(0);
      expect(result.elided).toBe(false);
    });
  });

  describe('hollowed function bodies (the captured staging variant)', () => {
    const HOLLOWED = `<html><body>
      <div class="controls">
        <input id="searchInput" placeholder="Search...">
        <button class="btn" id="exportBtn">Export CSV</button>
      </div>
      <script>
        const languages = [
          { id: 1, name: 'Python', popularity: 98, trend: [90, 92, 95, 96, 98] },
          { id: 2, name: 'JavaScript', popularity: 96, trend: [95, 97, 98, 97, 96] }
        ];

        // Initialize dashboard with all features
        function init() {
            // Render all UI components and attach event listeners
        }

        function renderTable() {
            // Render either flat or grouped table based on state
        }

        function filterLanguages() {
            // Apply search and paradigm filters
        }

        function exportCSV() {
            // Export filtered data as CSV file
        }

        function attachEventListeners() {
            // Search input listener
            // Paradigm chip click listeners
            // All other interactive elements
        }

        init();
      </script>
    </body></html>`;

    it('flags it, with high confidence', () => {
      const result = detectElidedContent(HOLLOWED, 'html');

      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('names every hollowed function', () => {
      const hollow = detectElidedContent(HOLLOWED, 'html')
        .signals.filter(s => s.kind === 'empty_function_body')
        .map(s => (s as { name: string }).name);

      expect(hollow).toEqual(['init', 'renderTable', 'filterLanguages', 'exportCSV', 'attachEventListeners']);
    });

    it('catches it on the signals the original two would have missed', () => {
      const result = detectElidedContent(HOLLOWED, 'html');

      // No referential stub phrases, and every called name resolves - so the verdict rests
      // entirely on the empty bodies.
      expect(result.signals.some(s => s.kind === 'placeholder_comment')).toBe(false);
      expect(result.signals.some(s => s.kind === 'undefined_reference')).toBe(false);
    });

    it('does not fire on TWO deliberate no-ops with distinct names', () => {
      // Hollow bodies never fire on their own below the conclusive threshold - they only
      // corroborate a reference miss. Two ordinary no-ops must stay clean.
      const body = `<html><body><script>
        function noop() {
          // intentionally does nothing - placeholder for the future export hook
        }
        function alsoNoop() {
          // intentionally does nothing - reserved for the print hook
        }
        function render() {
          document.title = 'ok';
          noop();
          alsoNoop();
        }
        render();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });

    it('fires when a hollow body is corroborated by an undefined reference', () => {
      const body = `<html><body><script>
        function init() {
          // Wire everything up
        }
        function start() { init(); renderBoard(); }
        start();
      </script></body></html>`;

      const result = detectElidedContent(body, 'html');
      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('low');
    });

    it('does not fire on a working artifact with one deliberate no-op', () => {
      const body = `<html><body><script>
        function noop() {
          // intentionally does nothing - placeholder for the future export hook
        }
        function render() {
          document.title = 'ok';
          noop();
        }
        render();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
    });
  });

  /**
   * The server calls the detector with `parseArtifacts()` output, so the MIME-to-internal-type
   * mapping sits between them. If that mapping drifted, `text/html` would stop matching
   * JS_BEARING_TYPES and the reference scan would silently never run - a failure that would
   * look exactly like "no elision detected".
   */
  describe('integration with parseArtifacts (the server call shape)', () => {
    it('flags an elided artifact parsed out of a full reply', () => {
      const reply = `Here is the updated dashboard.

<artifact identifier="board" type="text/html" title="Rank Board">${REAL_ELIDED_BODY}</artifact>

Let me know if you want more filters.`;

      const { artifacts } = parseArtifacts(reply);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].type).toBe('html');

      const result = detectElidedContent(artifacts[0].content, artifacts[0].type);
      expect(result.elided).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('leaves a complete parsed artifact clean', () => {
      const reply = `<artifact identifier="board" type="text/html" title="Rank Board">${COMPLETE_HTML}</artifact>`;

      const { artifacts } = parseArtifacts(reply);
      expect(detectElidedContent(artifacts[0].content, artifacts[0].type).elided).toBe(false);
    });

    it('maps a React artifact to the JS-bearing gate', () => {
      const reply = `<artifact identifier="d" type="application/vnd.ant.react" title="Dash">${COMPLETE_REACT}</artifact>`;

      const { artifacts } = parseArtifacts(reply);
      expect(artifacts[0].type).toBe('react');
      expect(detectElidedContent(artifacts[0].content, artifacts[0].type).elided).toBe(false);
    });
  });
});

/**
 * The detector runs inside a render memo on every artifact in a reply, so a large body must
 * not stall it. The reference scan previously sliced from index 0 at every call site, which
 * is O(n^2) - on a real 200KB dashboard that is enough string churn to freeze the UI.
 */
describe('large bodies', () => {
  it('stays fast when the body has tens of thousands of DISTINCT unresolved names', () => {
    // The shape the existing size-only guard below misses. The raw-source declaration re-check used
    // to compile a RegExp per candidate and rescan the whole body: O(names x body). Measured in
    // isolation on this exact input, that step alone took 41.8s; harvesting the declared set in one
    // pass takes 29ms. It runs synchronously on the completion worker and on the publish click, so
    // the cost is user-visible in both places. The threshold is loose on purpose - it is here to
    // catch a return to quadratic behaviour, not to police milliseconds.
    const lines = Array.from({ length: 30000 }, (_, i) => `  const value_${i} = compute_${i}(${i});`).join('\n');
    const body = `<html><body><script>\n${lines}\n  function go() { document.title = String(value_0); }\n  go();\n</script></body></html>`;

    const startedAt = Date.now();
    const result = detectElidedContent(body, 'html');
    const elapsedMs = Date.now() - startedAt;

    expect(result.signals.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it('stays fast when the body has one comment per line', () => {
    // A separate axis from the two guards around it, and previously unguarded: line-number resolution
    // rescanned from index 0 for every comment span, so cost grew with comments x bodySize. Measured
    // 213ms at 126KB and 5.7s at 720KB before a running newline count replaced it. This shape is not
    // steered - one trailing comment per line is ordinary LLM output - and it matters beyond the
    // single-response size cap because artifacts are expanded incrementally under one identifier and
    // the client fallback scan re-runs on every historical artifact reply at session load.
    const lines = Array.from(
      { length: 12000 },
      (_, i) => `  const value_${i} = ${i}; // assignment number ${i} for the running total`
    ).join('\n');
    const body = `<html><body><script>\n${lines}\n  function go() { document.title = String(value_0); }\n  go();\n</script></body></html>`;

    const startedAt = Date.now();
    const result = detectElidedContent(body, 'html');
    const elapsedMs = Date.now() - startedAt;

    expect(result.elided).toBe(false);
    expect(elapsedMs).toBeLessThan(3000);
  });

  it('scans a large complete artifact quickly and without flagging it', () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `  { id: ${i}, name: 'row-${i}', score: ${i % 97} },`).join(
      '\n'
    );
    const body = `<html><body><div id="board"></div><script>
      const DATA = [
${rows}
      ];
      function score(row) { return row.score * 2; }
      function renderBoard() {
        const board = document.getElementById('board');
        DATA.forEach(row => { board.appendChild(document.createElement('div')); score(row); });
      }
      function init() { renderBoard(); }
      init();
    </script></body></html>`;

    expect(body.length).toBeGreaterThan(150_000);

    const started = performance.now();
    const result = detectElidedContent(body, 'html');
    const elapsed = performance.now() - started;

    expect(result.elided).toBe(false);
    // Generous bound - the point is to catch a return to quadratic behaviour, not to benchmark.
    expect(elapsed).toBeLessThan(1000);
  });

  it('still distinguishes a member call from a bare call across long whitespace', () => {
    const body = `<html><body><script>
      const api = { load() { return 1; } };
      function init() {
        api.load();
        missingOne();
        missingTwo();
      }
      init();
    </script></body></html>`;

    const result = detectElidedContent(body, 'html');
    const missing = result.signals.filter(s => s.kind === 'undefined_reference').map(s => s.name);

    expect(missing).toContain('missingOne');
    expect(missing).toContain('missingTwo');
    expect(missing).not.toContain('load');
  });
});
