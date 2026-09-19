import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  corpusRegime,
  deriveArm,
  readEmbeddingFixtureHeader,
  rewriteFixtureQueries,
  formatCorpusRegime,
  hashQuestionText,
  isLongDocumentRegime,
  isTruncatableModel,
  loadEmbeddingFixture,
  PROD_REGIME_REFERENCE,
  readEmbeddingFixtureFile,
  writeEmbeddingFixtureFile,
  type EmbeddingFixture,
} from './embeddingFixture';
import { PROBE_QUESTIONS } from './corpus';
import tinyFixture from './fixtures/tiny-comparison.fixture.json';

const hashOf = (id: string) => hashQuestionText(PROBE_QUESTIONS.find(q => q.id === id)!.question);

const base = (over: Partial<EmbeddingFixture> = {}): unknown => ({
  model: 'text-embedding-3-small',
  dims: 4,
  corpus: 'test',
  capturedAt: '2026-09-08T00:00:00.000Z',
  filesInScope: 1,
  chunksExcluded: 0,
  filesExcluded: 0,
  filesUnreachable: 0,
  chunks: [{ chunkId: 'c1', docId: 'docA', vector: [1, 0, 0, 0], charLength: 2200 }],
  queries: [{ id: 'q01', vector: [0, 1, 0, 0], questionHash: hashOf('q01') }],
  ...over,
});

const norm = (v: number[]) => Math.hypot(...v);

describe('loadEmbeddingFixture', () => {
  it('accepts a capture whose vectors are all the declared width', () => {
    const fixture = loadEmbeddingFixture(base());
    expect(fixture.dims).toBe(4);
    expect(fixture.chunks).toHaveLength(1);
  });

  it('throws when a chunk vector is not the declared width, instead of scoring noise', () => {
    // computeCosineSimilarity returns 0 for a width mismatch, which a ranking then discards as an
    // ordinary low score - so the table would render complete, confident and wrong.
    const bad = base({ chunks: [{ chunkId: 'c1', docId: 'docA', vector: [1, 0], charLength: 2200 }] } as never);
    expect(() => loadEmbeddingFixture(bad)).toThrow(/another width/);
    expect(() => loadEmbeddingFixture(bad)).toThrow(/chunk c1:2/);
  });

  it('throws on a query vector of the wrong width too, not just a chunk', () => {
    const bad = base({ queries: [{ id: 'q01', vector: [1, 0, 0], questionHash: hashOf('q01') }] } as never);
    expect(() => loadEmbeddingFixture(bad)).toThrow(/query q01:3/);
  });

  it('rejects a structurally invalid capture rather than filling in defaults', () => {
    expect(() => loadEmbeddingFixture(base({ model: '' } as never))).toThrow();
    expect(() => loadEmbeddingFixture({ ...(base() as object), dims: undefined })).toThrow();
  });

  it('loads the committed synthetic fixture', () => {
    const fixture = loadEmbeddingFixture(tinyFixture);
    expect(fixture.dims).toBe(16);
    expect(fixture.chunks).toHaveLength(21);
    expect(fixture.queries).toHaveLength(5);
  });
});

describe('writeEmbeddingFixtureFile / readEmbeddingFixtureFile', () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), 'fixture-io-'));
  const many = (n: number): EmbeddingFixture['chunks'] =>
    Array.from({ length: n }, (_, i) => ({
      chunkId: `c${i}`,
      docId: `doc${i % 3}`,
      vector: [i, 0, 0, 1],
      charLength: 2200,
    }));

  const writeTo = (dir: string, over: Partial<EmbeddingFixture> = {}): string => {
    const file = path.join(dir, 'arm.fixture.ndjson');
    writeEmbeddingFixtureFile(file, loadEmbeddingFixture(base(over)));
    return file;
  };

  it('round-trips a capture through the line format unchanged', () => {
    const dir = tmp();
    const original = loadEmbeddingFixture(base({ chunks: many(1200) } as never));
    const file = path.join(dir, 'arm.fixture.ndjson');
    writeEmbeddingFixtureFile(file, original);
    expect(readEmbeddingFixtureFile(file)).toEqual(original);
  });

  it('writes one line per chunk plus a header, so no single string holds the corpus', () => {
    // The whole point of the format: `JSON.stringify` of a real lake exceeds V8's string cap, so a
    // capture that serialized in one piece would throw after the embedding spend.
    const file = writeTo(tmp(), { chunks: many(1200) } as never);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1201);
    expect(JSON.parse(lines[0])).toMatchObject({ format: 'ndjson-v1', chunkCount: 1200 });
    expect(JSON.parse(lines[0])).not.toHaveProperty('chunks');
    expect(JSON.parse(lines[1])).toMatchObject({ chunkId: 'c0' });
  });

  it('refuses a truncated capture rather than sweeping whatever survived', () => {
    // A capture killed mid-write leaves a syntactically perfect file holding part of the corpus.
    // Floors measured over it look measured, and read as a smaller lake rather than a broken file.
    const dir = tmp();
    const file = writeTo(dir, { chunks: many(1200) } as never);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    writeFileSync(file, `${lines.slice(0, 900).join('\n')}\n`);
    expect(() => readEmbeddingFixtureFile(file)).toThrow(/declares 1200 chunks but carries 899/);
  });

  it('names the line when a chunk line is corrupt, instead of failing on the whole file', () => {
    const dir = tmp();
    const file = writeTo(dir, { chunks: many(10) } as never);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    lines[4] = '{"chunkId":"c3","docId":';
    writeFileSync(file, `${lines.join('\n')}\n`);
    expect(() => readEmbeddingFixtureFile(file)).toThrow(/chunk line 4 is unparseable/);
  });

  it('still applies the width check when the capture arrives from disk', () => {
    // readEmbeddingFixtureFile assembles the fixture itself, so the guard that a mixed-width capture
    // must never load has to hold on this path too - not just on the in-memory one above.
    const dir = tmp();
    const file = writeTo(dir, { chunks: many(4) } as never);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    lines[2] = JSON.stringify({ chunkId: 'c1', docId: 'docA', vector: [1, 0], charLength: 2200 });
    writeFileSync(file, `${lines.join('\n')}\n`);
    expect(() => readEmbeddingFixtureFile(file)).toThrow(/another width/);
  });

  it('reads the committed synthetic fixture off disk, PRETTY-PRINTED as it is actually stored', () => {
    // Reads the real file, not a re-stringified copy of the imported object. Both CLIs are pointed at
    // this path by the runbook, and a pretty-printed capture's first line is a bare `{` - so a reader
    // that decided the format from line 1 alone rejected the one fixture the repo ships.
    const fixture = readEmbeddingFixtureFile(path.join(__dirname, 'fixtures/tiny-comparison.fixture.json'));
    expect(fixture.dims).toBe(16);
    expect(fixture.chunks).toHaveLength(21);
    expect(fixture.queries).toHaveLength(5);
  });

  it('reads a pre-format capture written as one line too', () => {
    const file = path.join(tmp(), 'legacy.fixture.json');
    writeFileSync(file, `${JSON.stringify(tinyFixture)}\n`);
    expect(readEmbeddingFixtureFile(file).chunks).toHaveLength(21);
  });

  it('rejects a file that is neither a header line nor a whole capture', () => {
    const file = path.join(tmp(), 'junk.fixture.ndjson');
    writeFileSync(file, 'not json at all\n');
    expect(() => readEmbeddingFixtureFile(file)).toThrow(/neither a "ndjson-v1" header line nor a whole/);
  });
});

describe('deriveArm', () => {
  const fixture = loadEmbeddingFixture(tinyFixture);

  it('names an arm by model AND width, because the width is part of the vector space', () => {
    expect(deriveArm(fixture, 8).arm).toBe('synthetic-eval-embedding@8');
    expect(deriveArm(fixture, 16).arm).toBe('synthetic-eval-embedding@16');
  });

  it('is a no-op at full width', () => {
    const full = deriveArm(fixture, 16);
    expect(full.chunks[0].vector).toEqual(fixture.chunks[0].vector);
    expect(full.queries[0].vector).toEqual(fixture.queries[0].vector);
  });

  it('returns unit-norm vectors at every narrower width', () => {
    for (const dims of [8, 4, 2]) {
      const arm = deriveArm(fixture, dims);
      expect(arm.chunks.every(c => c.vector.length === dims)).toBe(true);
      for (const c of arm.chunks) expect(norm(c.vector)).toBeCloseTo(1, 10);
      for (const q of arm.queries) expect(norm(q.vector)).toBeCloseTo(1, 10);
    }
  });

  it('truncates a prefix - a narrower arm keeps the leading components, renormalized', () => {
    const eight = deriveArm(fixture, 8).chunks[0].vector;
    const prefix = fixture.chunks[0].vector.slice(0, 8);
    const scale = norm(prefix);
    expect(eight.map(x => +(x * scale).toFixed(6))).toEqual(prefix);
  });

  it('refuses to widen past the capture width', () => {
    expect(() => deriveArm(fixture, 32)).toThrow(/only goes narrower/);
  });

  it('carries the capture exclusion counters through, so an arm cannot hide what it never saw', () => {
    const arm = deriveArm(fixture, 8);
    expect(arm.filesInScope).toBe(7);
    expect(arm.chunksExcluded).toBe(2);
    expect(arm.filesExcluded).toBe(1);
    expect(arm.filesUnreachable).toBe(3);
  });

  it('refuses to narrow a non-Matryoshka capture, whose prefix is not an embedding', () => {
    const ada = loadEmbeddingFixture(base({ model: 'text-embedding-ada-002' }));
    expect(() => deriveArm(ada, 2)).toThrow(/not a Matryoshka model/);
    // Its own capture width is still a legitimate arm.
    expect(deriveArm(ada, 4).arm).toBe('text-embedding-ada-002@4');
  });
});

describe('isTruncatableModel', () => {
  it('admits only the Matryoshka models the registry ships', () => {
    expect(isTruncatableModel({ model: 'text-embedding-3-small' })).toBe(true);
    expect(isTruncatableModel({ model: 'text-embedding-3-large' })).toBe(true);
  });

  it('refuses the pre-MRL and non-OpenAI embedders', () => {
    expect(isTruncatableModel({ model: 'text-embedding-ada-002' })).toBe(false);
    expect(isTruncatableModel({ model: 'voyage-3-large' })).toBe(false);
    expect(isTruncatableModel({ model: 'nomic-embed-text' })).toBe(false);
  });

  it('admits an unregistered model only when the fixture declares itself synthetic', () => {
    expect(isTruncatableModel({ model: 'synthetic-eval-embedding', syntheticMatryoshka: true })).toBe(true);
    expect(isTruncatableModel({ model: 'synthetic-eval-embedding' })).toBe(false);
  });

  it("refuses a typo'd model id, which the old registry-miss rule made truncatable", () => {
    // model-comparison.ts parses a fixture FILE, and the schema validates `model` as a non-empty
    // string - so a hand-edited typo used to render width arms of a model that never had them.
    expect(isTruncatableModel({ model: 'text-embedding-ada-oo2' })).toBe(false);
  });

  it('does not let the synthetic flag promote a model the registry knows is not Matryoshka', () => {
    expect(isTruncatableModel({ model: 'text-embedding-ada-002', syntheticMatryoshka: true })).toBe(false);
  });
});

describe('question-text integrity', () => {
  it('accepts a capture whose query hashes match the current PROBE_QUESTIONS', () => {
    expect(() => loadEmbeddingFixture(tinyFixture)).not.toThrow();
  });

  it('throws when a query vector embeds a question text corpus.ts no longer asks', () => {
    // The id set is identical, so assertSameQuerySet passes: the two arms are simply scored on
    // different questions under one label.
    const reworded = {
      ...tinyFixture,
      queries: tinyFixture.queries.map((q, i) => (i === 0 ? { ...q, questionHash: hashQuestionText('reworded') } : q)),
    };
    expect(() => loadEmbeddingFixture(reworded)).toThrow(/no longer what corpus.ts asks/);
    expect(() => loadEmbeddingFixture(reworded)).toThrow(/q01/);
  });

  it('requires the hash rather than treating its absence as agreement', () => {
    const { questionHash: _drop, ...noHash } = tinyFixture.queries[0];
    expect(() =>
      loadEmbeddingFixture({ ...tinyFixture, queries: [noHash, ...tinyFixture.queries.slice(1)] })
    ).toThrow();
  });

  it('leaves an id corpus.ts does not know to resolveQueries, which names it', () => {
    const unknown = {
      ...tinyFixture,
      queries: [...tinyFixture.queries, { id: 'q99', vector: tinyFixture.queries[0].vector, questionHash: 'deadbeef' }],
    };
    expect(() => loadEmbeddingFixture(unknown)).not.toThrow();
  });

  it('does not pin an EXTERNAL query to corpus.ts, even where its id collides with a committed one', () => {
    // The id-collision shape, which is the only one the external skip changes: an external set is
    // self-describing, so corpus.ts holds no text to pin it to and a shared id means nothing. Without
    // the skip this throws a stale-question error citing a question the capture never asked.
    const external = {
      ...tinyFixture,
      queries: tinyFixture.queries.map(q => ({
        ...q,
        questionHash: hashQuestionText(`external text for ${q.id}`),
        supporting: ['some-external-file-id'],
      })),
    };
    expect(() => loadEmbeddingFixture(external)).not.toThrow();
  });

  it('rejects an empty string in a carried supporting set', () => {
    // The question file's own schema refuses it, so a fixture carrying one was hand-edited; an empty
    // id matches no document and would score as a silent miss.
    const blank = {
      ...tinyFixture,
      queries: tinyFixture.queries.map(q => ({ ...q, supporting: [''] })),
    };
    expect(() => loadEmbeddingFixture(blank)).toThrow(/supporting/);
  });
});

describe('corpusRegime', () => {
  const chunks = [
    { docId: 'a', charLength: 100 },
    { docId: 'a', charLength: 200 },
    { docId: 'b', charLength: 300 },
    { docId: 'b', charLength: 4000 },
  ];

  it('reports the char-length distribution and chunks per file', () => {
    const r = corpusRegime(chunks);
    expect(r.files).toBe(2);
    expect(r.chunks).toBe(4);
    expect(r.chunksPerFile).toBe(2);
    expect(r.minChars).toBe(100);
    expect(r.maxChars).toBe(4000);
  });

  it('reports a percentile a real chunk actually has, not an interpolated one', () => {
    const r = corpusRegime(chunks);
    expect([100, 200, 300, 4000]).toContain(r.medianChars);
    expect([100, 200, 300, 4000]).toContain(r.p90Chars);
    expect(r.medianChars).toBe(200);
    expect(r.p90Chars).toBe(4000);
  });

  it('prefers an explicit file count over the distinct docIds present', () => {
    // Files whose chunks were all excluded still counted as in scope for the capture.
    expect(corpusRegime(chunks, 9).files).toBe(9);
  });

  it('is all zeros on an empty corpus rather than dividing by zero', () => {
    expect(corpusRegime([])).toMatchObject({ chunks: 0, chunksPerFile: 0, medianChars: 0 });
  });
});

describe('isLongDocumentRegime', () => {
  const regimeOf = (median: number) => corpusRegime([{ docId: 'a', charLength: median }]);

  it('passes a corpus in the prod passage regime', () => {
    expect(isLongDocumentRegime(regimeOf(PROD_REGIME_REFERENCE.medianChars))).toBe(true);
  });

  it('fails a corpus of short facts - the regime this ticket exists to stop inheriting', () => {
    expect(isLongDocumentRegime(regimeOf(180))).toBe(false);
  });

  it('says so in the rendered summary, not only in the boolean', () => {
    expect(formatCorpusRegime(regimeOf(180))).toContain('does not answer the question');
    expect(formatCorpusRegime(regimeOf(2200))).toContain('long-document regime : yes');
  });

  it('reads the committed synthetic fixture as in-regime', () => {
    const fixture = loadEmbeddingFixture(tinyFixture);
    expect(isLongDocumentRegime(corpusRegime(fixture.chunks, fixture.filesInScope))).toBe(true);
  });
});

describe('readEmbeddingFixtureHeader / rewriteFixtureQueries', () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), 'fixture-splice-'));
  const many = (n: number): EmbeddingFixture['chunks'] =>
    Array.from({ length: n }, (_, i) => ({
      chunkId: `c${i}`,
      docId: `doc${i % 3}`,
      vector: [i, 0, 0, 1],
      charLength: 2200,
    }));
  /** An external question set, which is the only kind a splice accepts. */
  const external = (over: Partial<EmbeddingFixture> = {}) =>
    loadEmbeddingFixture(
      base({
        chunks: many(1200),
        queries: [
          { id: 'x01', vector: [0, 1, 0, 0], questionHash: 'aaaa', supporting: [] },
          { id: 'x02', vector: [0, 0, 1, 0], questionHash: 'bbbb', supporting: ['docA'] },
        ],
        ...over,
      } as never)
    );
  const source = (dir: string, over: Partial<EmbeddingFixture> = {}): string => {
    const file = path.join(dir, 'arm.fixture.ndjson');
    writeEmbeddingFixtureFile(file, external(over));
    return file;
  };
  const newQuery = { id: 'x03', vector: [0, 0, 0, 1], questionHash: 'cccc', supporting: ['docB'] };

  it('reads the header without parsing the chunk lines', () => {
    const { header, chunkOffset } = readEmbeddingFixtureHeader(source(tmp()));
    expect(header.chunkCount).toBe(1200);
    expect(header.queries.map(q => q.id)).toEqual(['x01', 'x02']);
    expect(header).not.toHaveProperty('chunks');
    expect(chunkOffset).toBeGreaterThan(0);
  });

  it('refuses a whole-JSON capture by name, in both the shapes one arrives in', () => {
    // The reader deliberately accepts both forms, so a caller cannot tell them apart from the path.
    // The two shapes reach different guards: pretty-printed has `{` on line 1 and fails to parse,
    // compact parses as the whole capture and simply declares no format.
    const dir = tmp();
    const pretty = path.join(dir, 'pretty.json');
    writeFileSync(pretty, JSON.stringify(external(), null, 2));
    expect(() => readEmbeddingFixtureHeader(pretty)).toThrow(/cannot be spliced/);
    const compact = path.join(dir, 'compact.json');
    writeFileSync(compact, JSON.stringify(external()));
    expect(() => readEmbeddingFixtureHeader(compact)).toThrow(/does not declare format/);
  });

  it('carries the new queries over a corpus copied byte for byte', () => {
    const dir = tmp();
    const file = source(dir);
    const out = path.join(dir, 'extended.fixture.ndjson');
    const result = rewriteFixtureQueries({ source: file, out, queries: [...external().queries, newQuery] });
    expect(result).toEqual({ chunkLines: 1200, queries: 3 });

    const before = readEmbeddingFixtureFile(file);
    const after = readEmbeddingFixtureFile(out);
    expect(after.chunks).toEqual(before.chunks);
    expect(after.queries.map(q => q.id)).toEqual(['x01', 'x02', 'x03']);
    // Everything that describes the SNAPSHOT is preserved: the whole point is that the two question
    // sets are measured against one corpus, and a moved `capturedAt` would hide a re-capture.
    expect(after.capturedAt).toBe(before.capturedAt);
    expect(after.corpus).toBe(before.corpus);
    expect(after.filesInScope).toBe(before.filesInScope);
    // Byte-identical chunk region, not merely equal after parsing: a re-serialized float can print
    // at a different precision, which changes the vectors while every assertion above still passes.
    const region = (f: string) => {
      const buf = readFileSync(f);
      return buf.subarray(buf.indexOf(0x0a) + 1);
    };
    expect(region(out).equals(region(file))).toBe(true);
  });

  it('refuses to rewrite in place, which would truncate the corpus with its own header', () => {
    const file = source(tmp());
    expect(() => rewriteFixtureQueries({ source: file, out: file, queries: external().queries })).toThrow(/in place/);
  });

  it('refuses a query vector of another width', () => {
    const dir = tmp();
    const file = source(dir);
    expect(() =>
      rewriteFixtureQueries({
        source: file,
        out: path.join(dir, 'out.ndjson'),
        queries: [{ id: 'x04', vector: [1, 0], questionHash: 'dddd', supporting: [] }],
      })
    ).toThrow(/are not \(x04:2\)/);
  });

  it('refuses a partly external query set, which would score against two ground truths', () => {
    const dir = tmp();
    const file = source(dir);
    expect(() =>
      rewriteFixtureQueries({
        source: file,
        out: path.join(dir, 'out.ndjson'),
        queries: [external().queries[0], { id: 'x05', vector: [1, 0, 0, 0], questionHash: 'eeee' }],
      })
    ).toThrow(/partly\s+external/);
  });

  it('refuses a repeated query id', () => {
    const dir = tmp();
    const file = source(dir);
    const dup = external().queries[0];
    expect(() =>
      rewriteFixtureQueries({ source: file, out: path.join(dir, 'out.ndjson'), queries: [dup, dup] })
    ).toThrow(/repeated query id\(s\): x01/);
  });

  it('deletes the output when the copy is short of the declared chunk count', () => {
    // A fixture with new queries over a truncated corpus scores as a complete one over a smaller
    // lake, so leaving the file behind is worse than writing nothing.
    const dir = tmp();
    const file = path.join(dir, 'truncated.fixture.ndjson');
    const lines = readFileSync(source(dir, { chunks: many(10) } as never), 'utf8').split('\n');
    writeFileSync(file, [...lines.slice(0, 6), ''].join('\n'));
    const out = path.join(dir, 'out.ndjson');
    expect(() => rewriteFixtureQueries({ source: file, out, queries: external().queries })).toThrow(
      /Copied 5 chunk line\(s\).*declares 10/s
    );
    expect(existsSync(out)).toBe(false);
  });

  it('counts a final chunk line that has no trailing break', () => {
    const dir = tmp();
    const complete = readFileSync(source(dir, { chunks: many(10) } as never), 'utf8');
    const file = path.join(dir, 'no-trailing-break.fixture.ndjson');
    writeFileSync(file, complete.trimEnd());
    const out = path.join(dir, 'out.ndjson');
    expect(rewriteFixtureQueries({ source: file, out, queries: external().queries }).chunkLines).toBe(10);
  });
});
