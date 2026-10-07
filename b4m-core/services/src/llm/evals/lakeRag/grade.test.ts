import { describe, expect, it } from 'vitest';
import { loadLakeRagBank, type LakeRagBankRow } from './bank';
import { gradeLakeRag, gradeLakeRagEmpty, scoreByKind, type LakeRagCitationContext } from './grade';

const bank = loadLakeRagBank();

function row(id: string): LakeRagBankRow {
  const found = bank.find(r => r.id === id);
  if (!found) throw new Error(`no bank row ${id}`);
  return found;
}

function indexed(...titles: string[]): LakeRagCitationContext {
  return { citationStyle: 'indexed', citables: titles.map(title => ({ title })) };
}

const NAMED: LakeRagCitationContext = { citationStyle: 'named' };

describe('gradeLakeRag - fact', () => {
  const galileo = row('moons-fact-galilean-discovery');

  it('passes a cited answer carrying every expected token', () => {
    const grade = gradeLakeRag(
      galileo,
      'Galileo Galilei discovered them in January 1610 [1].',
      indexed('galilean-moons.md')
    );
    expect(grade).toMatchObject({ passed: true, kind: 'fact', answer: true, citation: { status: 'matched' } });
  });

  it('fails when one expected token is missing', () => {
    const grade = gradeLakeRag(galileo, 'Galileo discovered them [1].', indexed('galilean-moons.md'));
    expect(grade.passed).toBe(false);
    expect(grade.answer).toBe(false);
    expect(grade.reason).toContain('expected answer missing');
  });

  it('matches whole tokens only', () => {
    const cassini = row('moons-fact-cassini-end');
    expect(gradeLakeRag(cassini, 'It ended in 20170 [1].', indexed('titan-and-cassini.md')).answer).toBe(false);
    expect(gradeLakeRag(cassini, 'It ended in 2017.', indexed('titan-and-cassini.md')).answer).toBe(true);
  });

  it('accepts the alternatives a pattern spells out', () => {
    const units = row('si-fact-base-unit-count');
    expect(gradeLakeRag(units, 'There are seven [1].', indexed('si-base-units.md')).passed).toBe(true);
    expect(gradeLakeRag(units, 'There are 7 [1].', indexed('si-base-units.md')).passed).toBe(true);
  });
});

describe('gradeLakeRag - stale-same-name', () => {
  const saturn = row('moons-same-name-saturn-count');

  it('passes the current value', () => {
    const grade = gradeLakeRag(saturn, 'Saturn has 146 confirmed moons [1].', indexed('giant-planet-moons.md'));
    expect(grade).toMatchObject({ passed: true, kind: 'stale-same-name', staleRejected: true });
  });

  it('fails the superseded value even when cited to the right file name', () => {
    const grade = gradeLakeRag(saturn, 'Saturn has 82 confirmed moons [1].', indexed('giant-planet-moons.md'));
    expect(grade).toMatchObject({ passed: false, answer: false, staleRejected: false });
    expect(grade.reason).toContain('asserted stale value: 82');
  });

  it('fails a reply that offers both values as current', () => {
    const grade = gradeLakeRag(
      saturn,
      'Saturn has 146 confirmed moons [1]. Saturn has 82 confirmed moons [1].',
      indexed('giant-planet-moons.md')
    );
    expect(grade).toMatchObject({ passed: false, answer: true, staleRejected: false });
  });

  it('excuses a stale value its own sentence marks as outdated', () => {
    const grade = gradeLakeRag(
      saturn,
      'Saturn has 146 confirmed moons [1]. An earlier count put it at 82.',
      indexed('giant-planet-moons.md')
    );
    expect(grade.passed).toBe(true);
  });

  it('does not let a marker in one sentence excuse the next', () => {
    const grade = gradeLakeRag(
      saturn,
      'The earlier document is long. Saturn has 82 confirmed moons [1].',
      indexed('giant-planet-moons.md')
    );
    expect(grade.staleRejected).toBe(false);
  });

  it('does not reject the stale token inside a larger number', () => {
    const grade = gradeLakeRag(
      saturn,
      'Saturn has 146 confirmed moons [1], per the 1982 catalogue.',
      indexed('giant-planet-moons.md')
    );
    expect(grade.staleRejected).toBe(true);
  });
});

describe('gradeLakeRag - stale-different-name', () => {
  const population = row('census-different-name-population');
  const citables = indexed('census-2010-highlights.md', 'census-2020-highlights.md');

  it('passes the newer value cited to the newer document', () => {
    const grade = gradeLakeRag(population, 'The resident population is 331,449,281 [2].', citables);
    expect(grade).toMatchObject({ passed: true, kind: 'stale-different-name' });
  });

  it('accepts a rounded figure with a decimal point', () => {
    expect(gradeLakeRag(population, 'It is about 331.4 million people [2].', citables).passed).toBe(true);
  });

  it('catches a stale rounded figure a naive sentence split would cut in half', () => {
    const grade = gradeLakeRag(population, 'It is 331,449,281 [2]. The total is 308.7 million [1].', citables);
    expect(grade.staleRejected).toBe(false);
  });

  it('fails the older value cited to the older document', () => {
    const grade = gradeLakeRag(population, 'The resident population is 308,745,538 [1].', citables);
    expect(grade).toMatchObject({
      passed: false,
      answer: false,
      staleRejected: false,
      citation: { status: 'wrong-source' },
    });
  });
});

describe('gradeLakeRag - absent', () => {
  const pluto = row('moons-absent-pluto');

  it.each([
    "The knowledge base doesn't mention Pluto's moons.",
    'I could not find how many moons Pluto has in the provided documents.',
    "I can't find that in the lake.",
    'There is no information about Pluto in these sources.',
    "Pluto's moon count isn't covered by the documents.",
    'The documents do not contain that.',
  ])('passes a reply that names the gap: %s', reply => {
    expect(gradeLakeRag(pluto, reply, indexed()).passed).toBe(true);
  });

  it('fails a reply that just answers', () => {
    const grade = gradeLakeRag(pluto, 'Pluto has five known moons, the largest being Charon.', indexed());
    expect(grade).toMatchObject({
      passed: false,
      kind: 'absent',
      answer: false,
      citation: { status: 'not-applicable' },
    });
    expect(grade.reason).toContain('without saying the lake lacks it');
  });
});

describe('gradeLakeRag - indexed citation', () => {
  const ganymede = row('moons-fact-largest-moon');

  it('flags an uncited answer', () => {
    const grade = gradeLakeRag(ganymede, 'Ganymede.', indexed('galilean-moons.md'));
    expect(grade.citation).toEqual({ status: 'missing' });
    expect(grade.reason).toContain('did not cite galilean-moons.md');
  });

  it('resolves [N] to citables[N-1]', () => {
    const citables = indexed('titan-and-cassini.md', 'galilean-moons.md');
    expect(gradeLakeRag(ganymede, 'Ganymede [2].', citables).citation).toEqual({ status: 'matched' });
    expect(gradeLakeRag(ganymede, 'Ganymede [1].', citables).citation).toEqual({
      status: 'wrong-source',
      cited: ['titan-and-cassini.md'],
    });
  });

  it('reads a comma-separated marker', () => {
    const citables = indexed('titan-and-cassini.md', 'galilean-moons.md');
    expect(gradeLakeRag(ganymede, 'Ganymede [1, 2].', citables).citation).toEqual({ status: 'matched' });
  });

  it('fails an out-of-range marker even when another marker matches', () => {
    const grade = gradeLakeRag(ganymede, 'Ganymede [1][3].', indexed('galilean-moons.md'));
    expect(grade.citation).toEqual({ status: 'dangling', markers: [3] });
    expect(grade.passed).toBe(false);
  });
});

describe('gradeLakeRag - named citation', () => {
  const ganymede = row('moons-fact-largest-moon');

  it.each(['galilean-moons.md', 'galilean-moons', 'Galilean Moons'])('accepts %s', name => {
    expect(gradeLakeRag(ganymede, `Ganymede, per ${name}.`, NAMED).citation).toEqual({ status: 'matched' });
  });

  it('flags a reply that names no source', () => {
    expect(gradeLakeRag(ganymede, 'Ganymede.', NAMED).citation).toEqual({ status: 'missing' });
  });
});

describe('gradeLakeRagEmpty', () => {
  it('fails every check', () => {
    expect(gradeLakeRagEmpty(row('moons-fact-largest-moon'), 'no content')).toEqual({
      passed: false,
      reason: 'no content',
      kind: 'fact',
      answer: false,
      staleRejected: false,
      citation: { status: 'missing' },
    });
  });
});

describe('scoreByKind', () => {
  it('reports every kind, including ones with no grades', () => {
    expect(
      scoreByKind([
        { kind: 'fact', passed: true },
        { kind: 'fact', passed: false },
        { kind: 'stale-same-name', passed: true },
      ])
    ).toEqual({
      fact: { passed: 1, total: 2 },
      'stale-same-name': { passed: 1, total: 1 },
      'stale-different-name': { passed: 0, total: 0 },
      absent: { passed: 0, total: 0 },
    });
  });
});
