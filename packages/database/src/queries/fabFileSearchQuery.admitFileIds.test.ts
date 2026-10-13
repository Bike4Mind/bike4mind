import { describe, it, expect } from 'vitest';
import { buildOwnershipConditions } from './fabFileSearchQuery';

const F1 = '64b7f0c2a1b2c3d4e5f60718';

describe('buildOwnershipConditions - admitFileIds', () => {
  it('admits the listed ids under restrictToDataLake, still behind the base access arms', () => {
    const conditions = buildOwnershipConditions('u1', {
      restrictToDataLake: true,
      admitFileIds: [F1],
      userGroups: ['g1'],
    });
    expect(conditions).toHaveLength(1);
    const [arm] = conditions as Array<{ $and: [{ _id: { $in: string[] } }, { $or: object[] }] }>;
    expect(arm.$and[0]).toEqual({ _id: { $in: [F1] } });
    expect(arm.$and[1].$or).toEqual(expect.arrayContaining([{ userId: 'u1' }]));
    expect(arm.$and[1].$or).toHaveLength(3);
  });

  it('drops malformed ids so the query cannot throw a CastError on _id', () => {
    const conditions = buildOwnershipConditions('u1', {
      restrictToDataLake: true,
      admitFileIds: ['not-an-id', F1, '12'],
      dataLakeTags: ['datalake:x'],
    });
    const admit = conditions.find(c => JSON.stringify(c).includes('"_id"'));
    expect(admit).toEqual({ $and: [{ _id: { $in: [F1] } }, expect.anything()] });
    expect(JSON.stringify(conditions)).not.toContain('not-an-id');
  });

  it('is ignored without restrictToDataLake, where the base arms already reach those files', () => {
    const conditions = buildOwnershipConditions('u1', { admitFileIds: [F1] });
    expect(JSON.stringify(conditions)).not.toContain(F1);
  });

  it('still fails fast when there are neither lake arms nor admitted ids', () => {
    expect(() => buildOwnershipConditions('u1', { restrictToDataLake: true, admitFileIds: [] })).toThrow(
      /restrictToDataLake requires/
    );
  });
});
