import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { dailyNetWithWriteOffs, pairWriteOffs, writtenOffNewerThan, writtenOffSince } from './ledgerWriteOffs';

const id = (n: number) => new Types.ObjectId(n.toString(16).padStart(24, '0'));
const at = (iso: string) => new Date(iso);

describe('pairWriteOffs', () => {
  it.each(['ascending', 'descending'])('pairs the nearest equal-cost row with rows in %s order', order => {
    const rows = [
      { _id: id(1), questId: 'q1', credits: -100, createdAt: at('2026-11-05T10:00:00Z') },
      { _id: id(2), questId: 'q1', credits: -100, createdAt: at('2026-11-05T10:30:00Z') },
    ];
    const paired = pairWriteOffs(
      [{ requestId: 'q1', creditsCharged: 100, writtenOffCredits: 10, createdAt: at('2026-11-05T10:30:01Z') }],
      order === 'ascending' ? rows : [...rows].reverse()
    );

    expect(paired).toHaveLength(1);
    expect(paired[0].transactionId).toBe(id(2).toHexString());
  });

  it('breaks distance ties by earlier timestamp, then smaller id', () => {
    const paired = pairWriteOffs(
      [{ requestId: 'q1', creditsCharged: 100, writtenOffCredits: 10, createdAt: at('2026-11-05T10:00:01Z') }],
      [
        { _id: id(1), questId: 'q1', credits: -100, createdAt: at('2026-11-05T10:00:02Z') },
        { _id: id(3), questId: 'q1', credits: -100, createdAt: at('2026-11-05T10:00:00Z') },
        { _id: id(2), questId: 'q1', credits: -100, createdAt: at('2026-11-05T10:00:00Z') },
      ]
    );

    expect(paired).toHaveLength(1);
    expect(paired[0].transactionId).toBe(id(2).toHexString());
  });

  it('pairs each write-off with the ledger row of the same quest and gross credits, once', () => {
    const paired = pairWriteOffs(
      [
        { requestId: 'q1', creditsCharged: 2016, writtenOffCredits: 18, createdAt: at('2026-11-05T10:00:00Z') },
        { requestId: 'q2', creditsCharged: 500, writtenOffCredits: 40, createdAt: at('2026-11-05T11:00:00Z') },
      ],
      [
        // Same quest, different charge (an earlier uncapped settlement): not this write-off.
        { _id: id(1), questId: 'q1', credits: 16, createdAt: at('2026-11-05T09:00:00Z') },
        {
          _id: id(2),
          questId: 'q1',
          credits: -2016,
          createdAt: at('2026-11-05T10:00:01Z'),
          model: 'opus',
          source: 'web',
        },
        { _id: id(3), questId: 'q2', credits: 500, createdAt: at('2026-11-05T11:00:01Z') },
        { _id: id(4), questId: 'q2', credits: 500, createdAt: at('2026-11-05T11:00:02Z') },
      ]
    );
    expect(paired).toEqual([
      {
        transactionId: id(2).toHexString(),
        createdAt: at('2026-11-05T10:00:01Z'),
        writtenOffCredits: 18,
        model: 'opus',
        source: 'web',
      },
      {
        transactionId: id(3).toHexString(),
        createdAt: at('2026-11-05T11:00:01Z'),
        writtenOffCredits: 40,
        model: undefined,
        source: undefined,
      },
    ]);
  });

  it('never writes off more than the row charged', () => {
    const [writeOff] = pairWriteOffs(
      [{ requestId: 'q', creditsCharged: 10, writtenOffCredits: 50, createdAt: at('2026-11-05T10:00:00Z') }],
      [{ _id: id(1), questId: 'q', credits: 10, createdAt: at('2026-11-05T10:00:00Z') }]
    );
    expect(writeOff.writtenOffCredits).toBe(10);
  });
});

describe('write-off sums', () => {
  const writeOffs = {
    byTransactionId: new Map(),
    all: [
      { transactionId: id(5).toHexString(), createdAt: at('2026-11-05T10:00:00Z'), writtenOffCredits: 18 },
      { transactionId: id(9).toHexString(), createdAt: at('2026-11-06T10:00:00Z'), writtenOffCredits: 7 },
    ],
  };

  it('counts only rows strictly newer than a ledger position, ties broken by id', () => {
    expect(writtenOffNewerThan(writeOffs, { createdAt: at('2026-11-05T10:00:00Z'), id: id(4).toHexString() })).toBe(25);
    expect(writtenOffNewerThan(writeOffs, { createdAt: at('2026-11-05T10:00:00Z'), id: id(5).toHexString() })).toBe(7);
    expect(writtenOffNewerThan(writeOffs, { createdAt: at('2026-11-07T00:00:00Z'), id: id(1).toHexString() })).toBe(0);
  });

  it('sums since a time', () => {
    expect(writtenOffSince(writeOffs, at('2026-11-06T00:00:00Z'))).toBe(7);
  });

  it('adds write-offs back to the day they happened, inside the window', () => {
    const daily = dailyNetWithWriteOffs(
      [{ day: '2026-11-05', netCredits: 2000 - 2016 }],
      writeOffs,
      at('2026-11-05T00:00:00Z')
    );
    expect(daily).toEqual([
      { day: '2026-11-05', netCredits: 2 },
      { day: '2026-11-06', netCredits: 7 },
    ]);
    expect(dailyNetWithWriteOffs([], writeOffs, at('2026-11-06T00:00:00Z'))).toEqual([
      { day: '2026-11-06', netCredits: 7 },
    ]);
  });
});
