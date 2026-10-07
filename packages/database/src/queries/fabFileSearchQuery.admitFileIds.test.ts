import { describe, it, expect } from 'vitest';
import { buildOwnershipConditions } from './fabFileSearchQuery';

describe('buildOwnershipConditions - admitFileIds', () => {
  it('admits the listed ids under restrictToDataLake, still behind the base access arms', () => {
    const conditions = buildOwnershipConditions('u1', {
      restrictToDataLake: true,
      admitFileIds: ['f1'],
      userGroups: ['g1'],
    });
    expect(conditions).toHaveLength(1);
    const [arm] = conditions as Array<{ $and: [{ _id: { $in: string[] } }, { $or: object[] }] }>;
    expect(arm.$and[0]).toEqual({ _id: { $in: ['f1'] } });
    expect(arm.$and[1].$or).toEqual(expect.arrayContaining([{ userId: 'u1' }]));
    expect(arm.$and[1].$or).toHaveLength(3);
  });

  it('is ignored without restrictToDataLake, where the base arms already reach those files', () => {
    const conditions = buildOwnershipConditions('u1', { admitFileIds: ['f1'] });
    expect(JSON.stringify(conditions)).not.toContain('f1');
  });

  it('still fails fast when there are neither lake arms nor admitted ids', () => {
    expect(() => buildOwnershipConditions('u1', { restrictToDataLake: true, admitFileIds: [] })).toThrow(
      /restrictToDataLake requires/
    );
  });
});
