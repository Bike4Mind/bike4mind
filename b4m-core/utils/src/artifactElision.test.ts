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

describe('detectElidedContent', () => {
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

    it('does not scan a script src attribute as a comment', () => {
      const body = `<html><body>
        <script src="//cdn.example.com/rest-of-the-lib.js"></script>
        <script>function go(){ document.title='x'; } go();</script>
      </body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
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

    it('treats a bare //localhost URL as a URL, but //word: as a comment', () => {
      // `localhost` is the one routine dotless host, so it is admitted by name. Admitting dotless
      // hosts generally would swallow `//TODO: ...` comments and stop scanning them entirely -
      // the second half of this test is what pins that line.
      const url = `<html><body><script>
//localhost:3000/for-brevity-notes.js
        function render() { document.title = 'ok'; }
        render();
      </script></body></html>`;
      const comment = `<html><body><script>
//TODO: rest of the code omitted
        function render() { document.title = 'ok'; }
        render();
      </script></body></html>`;

      expect(detectElidedContent(url, 'html').elided).toBe(false);
      expect(detectElidedContent(comment, 'html').elided).toBe(true);
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
      // `function foo() {}` matches both the declaration pattern and the method-shorthand pattern.
      // Counting it twice would reach the 3-body high-confidence threshold on two real functions.
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

    it('does not treat control flow or an empty constructor as a hollow body', () => {
      const body = `<html><body><script>
        class Thing { constructor() {} }
        function go(items) {
          if (!items.length) { }
          for (const i of items) { }
          try { document.title = 'x'; } catch (e) { }
          return new Thing();
        }
        go([]);
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
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
