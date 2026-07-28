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

    it('does not flag stub phrases inside string literals', () => {
      const body = `<html><body><script>
        const NOTICE = 'for brevity, see the appendix';
        function render() { document.title = NOTICE; }
        render();
      </script></body></html>`;

      expect(detectElidedContent(body, 'html').elided).toBe(false);
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
