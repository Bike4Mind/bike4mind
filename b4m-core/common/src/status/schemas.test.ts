import { describe, expect, it } from 'vitest';
import { makeBreakglass, makeExternal, makeHead, makeRichInput, makeSummary } from './__fixtures__/statusFixtures';
import { projectPublicSnapshot } from './project';
import {
  LENIENT_PUBLIC_SCHEMAS,
  PUBLIC_FILE_KINDS,
  PublicSummarySchema,
  STRICT_PUBLIC_SCHEMAS,
  parsePublicFile,
  parseSummaryLenient,
  parseSummaryStrict,
  type PublicFileKind,
} from './schemas.public';
import { PUBLIC_INCIDENT_ID_PATTERN, PUBLIC_SLUG_PATTERN } from './types';

const projected = projectPublicSnapshot(makeRichInput());
const samples: Record<PublicFileKind, unknown> = {
  summary: projected.summary,
  incident: projected.incidentFiles.r3solved01,
  incidents: projected.incidentsIndex,
  archive: Object.values(projected.archives)[0],
  uptime: projected.uptime,
  breakglass: makeBreakglass(
    [
      {
        ...makeHead(),
        latestUpdates: [{ ...makeHead().latestUpdates[0], editedAt: '2026-11-23T19:00:00Z' }],
        writtenSeq: 13,
        journalNonce: 'n0nce000000000000001',
      },
    ],
    { externalOverride: { writtenSeq: 13, ignoreUntil: '2026-11-23T20:00:00Z' } }
  ),
  external: makeExternal(),
  statusJson: {
    page: { name: 'Example Status', url: 'https://status.example.com', updated_at: '2026-11-23T19:40:07Z' },
    status: { indicator: 'minor', description: 'Partial system degradation' },
  },
};

/** Every clone of `value` with one unknown key added to exactly one object. */
function withUnknownKeyAtEveryObject(value: unknown): { path: string; clone: unknown }[] {
  const results: { path: string; clone: unknown }[] = [];
  const visit = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) node.forEach((item, index) => visit(item, [...path, String(index)]));
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) visit(child, [...path, key]);
      const clone = structuredClone(value) as Record<string, unknown>;
      let target = clone as Record<string, unknown>;
      for (const part of path) target = target[part] as Record<string, unknown>;
      target.unexpectedField = 'x';
      results.push({ path: path.join('.') || '(root)', clone });
    }
  };
  visit(value, []);
  return results;
}

describe.each(PUBLIC_FILE_KINDS)('%s', kind => {
  const sample = samples[kind];

  it('parses a valid file in both modes', () => {
    expect(parsePublicFile(kind, sample, 'strict').ok).toBe(true);
    expect(parsePublicFile(kind, sample, 'lenient').ok).toBe(true);
  });

  it('strict rejects an unknown field at every depth', () => {
    const mutations = withUnknownKeyAtEveryObject(sample);
    expect(mutations.length).toBeGreaterThan(0);
    for (const { path, clone } of mutations) {
      expect(parsePublicFile(kind, clone, 'strict').ok, `strict accepted an unknown key at ${path}`).toBe(false);
    }
  });

  it('lenient strips an unknown field at every depth', () => {
    const baseline = LENIENT_PUBLIC_SCHEMAS[kind].parse(sample);
    for (const { path, clone } of withUnknownKeyAtEveryObject(sample)) {
      const parsed = parsePublicFile(kind, clone, 'lenient');
      expect(parsed.ok, `lenient rejected ${path}`).toBe(true);
      expect(parsed.ok && parsed.data).toEqual(baseline);
    }
  });
});

describe('depth coverage of the samples', () => {
  it('reaches vendor, child, maintenance, postmortem and uptime shapes', () => {
    const summary = projected.summary;
    expect(summary.components.some(c => c.vendor?.upstream)).toBe(true);
    expect(summary.components.some(c => c.children.length > 0)).toBe(true);
    expect(summary.components.some(c => c.maintenance)).toBe(true);
    expect(summary.upcomingMaintenance.length).toBeGreaterThan(0);
    expect((samples.incident as { postmortem: unknown }).postmortem).not.toBeNull();
    expect(projected.uptime.components[0].days.length).toBeGreaterThan(0);
  });
});

describe('break-glass journal nonce', () => {
  const withNonce = (journalNonce: string) => makeBreakglass([{ ...makeHead(), writtenSeq: 1, journalNonce }]);

  it.each(['journal/AIDAEXAMPLE/n0nce000000000000001.json', 'AROAEXAMPLE:person@example.com', 'short', ''])(
    'rejects %j in both modes',
    value => {
      expect(parsePublicFile('breakglass', withNonce(value), 'strict').ok).toBe(false);
      expect(parsePublicFile('breakglass', withNonce(value), 'lenient').ok).toBe(false);
    }
  );

  it('rejects an entry that still carries a journalKey', () => {
    const entry = {
      ...makeHead(),
      writtenSeq: 1,
      journalNonce: 'n0nce000000000000001',
      journalKey: 'journal/x/y.json',
    };
    expect(parsePublicFile('breakglass', makeBreakglass([entry as never]), 'strict').ok).toBe(false);
  });
});

describe('calendar-invalid timestamps', () => {
  it('rejects a timestamp that matches the shape but is not a real time', () => {
    for (const bad of ['2026-13-01T00:00:00Z', '2026-11-45T00:00:00Z', '2026-11-23T25:00:00Z']) {
      expect(parseSummaryStrict({ ...makeSummary(), probesAsOf: bad }).ok).toBe(false);
      expect(parseSummaryLenient({ ...makeSummary(), probesAsOf: bad }).ok).toBe(false);
    }
    expect(parseSummaryStrict(makeSummary()).ok).toBe(true);
  });
});

describe('probesTrigger', () => {
  it.each(['scheduled', 'manual', null])('accepts %s', value => {
    expect(parseSummaryStrict({ ...makeSummary(), probesTrigger: value }).ok).toBe(true);
    expect(parseSummaryLenient({ ...makeSummary(), probesTrigger: value }).ok).toBe(true);
  });

  it('rejects other values', () => {
    expect(parseSummaryStrict({ ...makeSummary(), probesTrigger: 'cron' }).ok).toBe(false);
    expect(parseSummaryLenient({ ...makeSummary(), probesTrigger: 'cron' }).ok).toBe(false);
  });

  it('strict requires the field; lenient defaults it to null for files written before it existed', () => {
    const { probesTrigger: _omit, ...old } = makeSummary();
    expect(parseSummaryStrict(old).ok).toBe(false);
    const lenient = parseSummaryLenient(old);
    expect(lenient.ok && lenient.data.probesTrigger).toBeNull();
  });

  it('sits beside probesAsOf in the strict shape', () => {
    const keys = Object.keys(PublicSummarySchema.shape);
    expect(keys.indexOf('probesTrigger')).toBe(keys.indexOf('probesAsOf') + 1);
  });
});

describe('https refinement', () => {
  const bad = ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', '//example.com', 'example.com', ''];

  it.each(bad)('appUrl %j is rejected by strict and lenient', value => {
    const summary = { ...makeSummary(), page: { ...makeSummary().page, appUrl: value } };
    expect(parseSummaryStrict(summary).ok).toBe(false);
    expect(parseSummaryLenient(summary).ok).toBe(false);
  });

  it.each(bad)('vendor statusPageUrl %j is rejected', value => {
    const base = makeSummary();
    const component = { ...base.components[0], vendor: { statusPageUrl: value, upstream: null } };
    expect(parseSummaryStrict({ ...base, components: [component] }).ok).toBe(false);
    expect(parseSummaryLenient({ ...base, components: [component] }).ok).toBe(false);
  });

  it.each(bad)('postmortem url %j is rejected', value => {
    const incident = structuredClone(samples.incident) as { postmortem: { url: string } };
    incident.postmortem.url = value;
    expect(parsePublicFile('incident', incident, 'strict').ok).toBe(false);
    expect(parsePublicFile('incident', incident, 'lenient').ok).toBe(false);
  });

  it('accepts https URLs', () => {
    expect(parseSummaryStrict(makeSummary()).ok).toBe(true);
  });
});

describe('field rules', () => {
  it('requires a 10 character random id with no prefix', () => {
    expect(PUBLIC_INCIDENT_ID_PATTERN.test('k3v9q2m7xa')).toBe(true);
    for (const bad of ['', 'K3V9Q2M7XA', 'k3v9q2m7x', 'k3v9q2m7xaa', 'inc_k3v9q2m7', 'k3v9q2m7x-', 'k3v9q2m7x ']) {
      expect(PUBLIC_INCIDENT_ID_PATTERN.test(bad), bad).toBe(false);
    }
    const summary = makeSummary({ activeIncidents: [makeHead({ id: 'inc_123' })] });
    expect(parseSummaryStrict(summary).ok).toBe(false);
  });

  it('requires a valid public slug', () => {
    expect(PUBLIC_SLUG_PATTERN.test('web-app')).toBe(true);
    for (const bad of ['ab', '1abc', 'Abc', 'a_b_c', 'a'.repeat(42)])
      expect(PUBLIC_SLUG_PATTERN.test(bad), bad).toBe(false);
  });

  it('rejects out of range uptime and malformed day tuples', () => {
    const uptime = structuredClone(samples.uptime) as { components: { uptime: number | null; days: unknown[] }[] };
    uptime.components[0].uptime = 1.2;
    expect(parsePublicFile('uptime', uptime, 'strict').ok).toBe(false);
    uptime.components[0].uptime = 0.5;
    uptime.components[0].days = [['z', 1, 1, 1]];
    expect(parsePublicFile('uptime', uptime, 'strict').ok).toBe(false);
    uptime.components[0].days = [['o', 10_000, 0]];
    expect(parsePublicFile('uptime', uptime, 'strict').ok).toBe(false);
  });

  it('bounds title and update body lengths', () => {
    expect(parseSummaryStrict(makeSummary({ activeIncidents: [makeHead({ title: 'x'.repeat(121) })] })).ok).toBe(false);
    const head = makeHead();
    const long = { ...head, latestUpdates: [{ ...head.latestUpdates[0], body: 'x'.repeat(1_001) }] };
    expect(parseSummaryStrict(makeSummary({ activeIncidents: [long] })).ok).toBe(false);
  });

  it('rejects malformed timestamps and unknown enum values', () => {
    expect(parseSummaryStrict({ ...makeSummary(), generatedAt: 'yesterday' }).ok).toBe(false);
    expect(parseSummaryStrict({ ...makeSummary(), overall: { state: 'on_fire', notice: null } }).ok).toBe(false);
  });

  it('registry has a strict and a lenient schema for every kind', () => {
    for (const kind of PUBLIC_FILE_KINDS) {
      expect(STRICT_PUBLIC_SCHEMAS[kind]).toBeDefined();
      expect(LENIENT_PUBLIC_SCHEMAS[kind]).toBeDefined();
    }
  });
});

describe('status belongs to the kind', () => {
  type Pair = [kind: 'incident' | 'maintenance', status: string];
  const headOf = ([kind, status]: Pair) => makeHead({ kind, status: status as never });
  const scalarsOf = (pair: Pair) => {
    const { latestUpdates: _latestUpdates, ...scalars } = headOf(pair);
    return scalars;
  };
  const files: Record<string, (pair: Pair) => [PublicFileKind, unknown]> = {
    summary: pair => ['summary', { ...(samples.summary as object), activeIncidents: [headOf(pair)] }],
    incident: pair => ['incident', { ...(samples.incident as object), incident: { ...scalarsOf(pair), updates: [] } }],
    incidents: pair => ['incidents', { ...(samples.incidents as object), incidents: [scalarsOf(pair)] }],
    archive: pair => ['archive', { ...(samples.archive as object), incidents: [scalarsOf(pair)] }],
    breakglass: pair => [
      'breakglass',
      {
        ...(samples.breakglass as object),
        entries: [{ ...headOf(pair), writtenSeq: 13, journalNonce: 'n0nce000000000000001' }],
      },
    ],
  };
  const valid: Pair[] = [
    ['incident', 'identified'],
    ['incident', 'resolved'],
    ['maintenance', 'scheduled'],
    ['maintenance', 'completed'],
    ['maintenance', 'cancelled'],
  ];
  const invalid: Pair[] = [
    ['incident', 'completed'],
    ['incident', 'scheduled'],
    ['incident', 'cancelled'],
    ['maintenance', 'investigating'],
    ['maintenance', 'resolved'],
  ];

  describe.each(Object.keys(files))('%s', file => {
    it.each(['strict', 'lenient'] as const)('%s mode accepts matching pairs and refuses the rest', mode => {
      const parse = (pair: Pair) => parsePublicFile(...(files[file](pair) as [PublicFileKind, unknown]), mode).ok;
      for (const pair of valid) expect(parse(pair), pair.join('/')).toBe(true);
      for (const pair of invalid) expect(parse(pair), pair.join('/')).toBe(false);
    });
  });
});

describe('support address in the summary page', () => {
  const without = () => {
    const summary = structuredClone(makeSummary()) as { page: Record<string, unknown> };
    delete summary.page.supportEmail;
    return summary;
  };

  it('parses a summary without the key and outputs null, strict and lenient', () => {
    for (const parse of [parseSummaryStrict, parseSummaryLenient]) {
      const result = parse(without());
      expect(result.ok && result.data.page.supportEmail).toBeNull();
    }
  });

  it('accepts a well-formed address and rejects a malformed one', () => {
    const withEmail = (value: unknown) => ({ ...makeSummary(), page: { ...makeSummary().page, supportEmail: value } });
    expect(parseSummaryStrict(withEmail('support@example.com')).ok).toBe(true);
    for (const bad of ['nope', 'Support@Example.com', 'a@b', `${'a'.repeat(250)}@example.com`]) {
      expect(parseSummaryStrict(withEmail(bad)).ok).toBe(false);
      expect(parseSummaryLenient(withEmail(bad)).ok).toBe(false);
    }
  });
});
