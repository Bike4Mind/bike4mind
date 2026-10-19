import { describe, it, expect } from 'vitest';
import { addedLines, compileTerms, run } from '../check-restricted-terms.mjs';

// Invented placeholder terms; the real list lives only in the repository secret.
const TERMS = ['zorblax', 'flim-?flam', '# a comment line', '', 'glorp\\d+'].join('\n');

function response(body, { status = 200, link } = {}) {
  return {
    ok: status < 400,
    status,
    headers: { get: name => (name.toLowerCase() === 'link' ? (link ?? null) : null) },
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer,
  };
}

// Routes are matched on the URL path with the query string removed.
function fakeFetch(routes) {
  return async url => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return response({ message: 'Not Found' }, { status: 404 });
    return typeof route === 'function' ? route(url) : route;
  };
}

const PR_EVENT = { pull_request: { number: 7 } };

function pr(overrides = {}) {
  return {
    number: 7,
    title: 'feat(client): add a widget',
    body: 'Adds a widget.',
    head: { ref: 'feat/widget', sha: 'h'.repeat(40) },
    commits: 1,
    changed_files: 1,
    ...overrides,
  };
}

const commit = (message, sha = 'c'.repeat(40)) => ({ sha, commit: { message } });
const file = (filename, patch, extra = {}) => ({ filename, status: 'modified', changes: 1, patch, ...extra });

async function check({ event = PR_EVENT, eventName = 'pull_request_target', routes, terms = TERMS }) {
  const lines = [];
  const code = await run({
    env: {
      RESTRICTED_TERMS: terms,
      GITHUB_TOKEN: 'token',
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: 'event.json',
      GITHUB_REPOSITORY: 'acme/widgets',
    },
    fetchImpl: fakeFetch(routes),
    log: line => lines.push(line),
    readFile: () => JSON.stringify(event),
  });
  return { code, output: lines.join('\n') };
}

function prRoutes({
  pull = pr(),
  commits = [commit('feat: widget')],
  files = [file('src/a.ts', '@@ -1,0 +1,1 @@\n+ok')],
} = {}) {
  return {
    '/repos/acme/widgets/pulls/7': response(pull),
    '/repos/acme/widgets/pulls/7/commits': response(commits),
    '/repos/acme/widgets/pulls/7/files': response(files),
  };
}

describe('compileTerms', () => {
  const m = compileTerms(TERMS);

  it('matches case-insensitively', () => {
    expect(m.test('ZorBlax')).toBe(true);
    expect(m.test('FLIMFLAM')).toBe(true);
  });

  it('matches whole words only', () => {
    expect(m.test('zorblaxian')).toBe(false);
    expect(m.test('prezorblax')).toBe(false);
    expect(m.test('the zorblax engine')).toBe(true);
  });

  it('treats punctuation and underscores as word boundaries', () => {
    for (const text of ['zorblax_helper', 'use-zorblax', 'pkg/zorblax/index.ts', '"zorblax".']) {
      expect(m.test(text), text).toBe(true);
    }
  });

  it('applies regex fragments', () => {
    expect(m.test('flim-flam')).toBe(true);
    expect(m.test('glorp42')).toBe(true);
    expect(m.test('glorp')).toBe(false);
  });

  it('ignores blank and comment lines', () => {
    expect(m.test('a comment line')).toBe(false);
    expect(m.test('')).toBe(false);
  });

  it('does not echo the list when the fragments fail to compile together', () => {
    // Stand in for a combined-pattern failure (for example "too large"), whose
    // SyntaxError quotes the full source.
    const RealRegExp = RegExp;
    globalThis.RegExp = function (source, flags) {
      if (source.startsWith('(?<!')) throw new SyntaxError(`Invalid regular expression: /${source}/`);
      return new RealRegExp(source, flags);
    };
    let message = '';
    try {
      compileTerms(TERMS);
    } catch (err) {
      message = err.message;
    } finally {
      globalThis.RegExp = RealRegExp;
    }
    expect(message).toMatch(/does not compile as one pattern/);
    expect(message).not.toMatch(/zorblax/i);
  });

  it('returns null for an empty list', () => {
    expect(compileTerms(undefined)).toBeNull();
    expect(compileTerms('\n  \n# only a comment\n')).toBeNull();
  });

  it('reports an invalid fragment by line number without echoing it', () => {
    expect(() => compileTerms('zorblax\nbad(frag')).toThrow(/^Line 2 of the restricted-term list is not a valid/);
    try {
      compileTerms('zorblax\nbad(frag');
    } catch (err) {
      expect(err.message).not.toContain('bad(frag');
    }
  });
});

describe('addedLines', () => {
  it('returns only added lines, numbered in the new file', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' keep',
      '-gone',
      '+new one',
      ' keep',
      '+new two',
      '@@ -20,1 +21,2 @@',
      ' ctx',
      '+late',
    ].join('\n');
    expect(addedLines(patch)).toEqual([
      { line: 2, text: 'new one' },
      { line: 4, text: 'new two' },
      { line: 22, text: 'late' },
    ]);
  });

  it('ignores the no-newline marker', () => {
    expect(addedLines('@@ -0,0 +1 @@\n+only\n\\ No newline at end of file')).toEqual([{ line: 1, text: 'only' }]);
  });
});

describe('run', () => {
  it('fails with a maintainer-facing message when the secret is missing', async () => {
    const { code, output } = await check({ terms: '', routes: prRoutes() });
    expect(code).toBe(1);
    expect(output).toContain('RESTRICTED_TERMS secret is missing or empty');
  });

  it('passes a clean PR', async () => {
    const { code, output } = await check({ routes: prRoutes() });
    expect(code).toBe(0);
    expect(output).toContain('No restricted terms found.');
  });

  it('reports every location without echoing the matched text', async () => {
    const { code, output } = await check({
      routes: prRoutes({
        pull: pr({
          title: 'feat: Zorblax support',
          body: 'adds flim-flam',
          head: { ref: 'feat/zorblax', sha: 'h'.repeat(40) },
        }),
        commits: [commit('wire up glorp9', 'a'.repeat(40)), commit('clean', 'b'.repeat(40))],
        files: [
          file('src/a.ts', '@@ -1,2 +1,3 @@\n keep\n+const x = "zorblax";\n-zorblax was here\n keep'),
          file('src/zorblax.ts', '@@ -0,0 +1,1 @@\n+fine', { status: 'added' }),
        ],
      }),
    });
    expect(code).toBe(1);
    expect(output).toContain('Restricted term found in PR title.');
    expect(output).toContain('Restricted term found in PR body.');
    expect(output).toContain('Restricted term found in head branch name.');
    expect(output).toContain(`Restricted term found in commit ${'a'.repeat(12)} message.`);
    expect(output).not.toContain('b'.repeat(12));
    expect(output).toContain('Restricted term found in file src/a.ts line 2.');
    expect(output).toContain('Restricted term found in changed file #2 (path withheld): the file path.');
    expect(output.toLowerCase()).not.toMatch(/zorblax|flim|glorp/);
  });

  it('escapes a newline in a reported path so it cannot inject a workflow command', async () => {
    const { code, output } = await check({
      routes: prRoutes({ files: [file('src/a\n::stop-commands::x.ts', '@@ -0,0 +1 @@\n+zorblax')] }),
    });
    expect(code).toBe(1);
    expect(output).toContain('file src/a%0A::stop-commands::x.ts line 1');
    expect(output.split('\n').some(line => line.startsWith('::stop-commands::'))).toBe(false);
  });

  it('ignores removed lines', async () => {
    const { code } = await check({ routes: prRoutes({ files: [file('src/a.ts', '@@ -1,1 +0,0 @@\n-zorblax')] }) });
    expect(code).toBe(0);
  });

  it('follows pagination', async () => {
    const routes = prRoutes();
    routes['/repos/acme/widgets/pulls/7/files'] = url =>
      url.includes('page=2')
        ? response([file('src/b.ts', '@@ -0,0 +1 @@\n+zorblax')])
        : response([file('src/a.ts', '@@ -0,0 +1 @@\n+ok')], {
            link: '<https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=2>; rel="next"',
          });
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('file src/b.ts line 1');
  });

  it('checks a large text file in full and skips binary files', async () => {
    const routes = prRoutes({
      files: [file('big.txt', undefined, { changes: 5000 }), file('img.png', undefined, { changes: 10 })],
    });
    routes['/repos/acme/widgets/contents/big.txt'] = response('line one\nzorblax here');
    routes['/repos/acme/widgets/contents/img.png'] = {
      ...response(''),
      arrayBuffer: async () => new Uint8Array([0x89, 0, 0x7a]).buffer,
    };
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('file big.txt line 2');
    expect(output).not.toContain('img.png');
  });

  it('fails without echoing the body when an API response is not JSON', async () => {
    const routes = prRoutes();
    routes['/repos/acme/widgets/pulls/7/files'] = {
      ...response(null),
      json: async () => JSON.parse('<html>zorblax</html>'),
    };
    const { code, output } = await check({ routes });
    expect(code).toBe(1);
    expect(output).toContain('could not complete: unexpected SyntaxError.');
    expect(output.toLowerCase()).not.toContain('zorblax');
  });

  it('fails closed when the PR is too large to list completely', async () => {
    const { code, output } = await check({ routes: prRoutes({ pull: pr({ changed_files: 3001 }) }) });
    expect(code).toBe(1);
    expect(output).toContain('Incomplete check');
  });

  it('checks commit messages and added lines of a push', async () => {
    const event = { ref: 'refs/heads/main', before: '1'.repeat(40), after: '2'.repeat(40) };
    const routes = {
      [`/repos/acme/widgets/compare/${event.before}...${event.after}`]: response({
        commits: [commit('fix: Flim-Flam', 'd'.repeat(40))],
        files: [file('src/c.ts', '@@ -0,0 +1 @@\n+ok')],
      }),
    };
    const { code, output } = await check({ eventName: 'push', event, routes });
    expect(code).toBe(1);
    expect(output).toContain(`commit ${'d'.repeat(12)} message`);
    expect(output).toContain('already on the branch');
    expect(output.toLowerCase()).not.toContain('flim');
  });
});
