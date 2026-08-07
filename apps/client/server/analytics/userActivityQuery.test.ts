import { describe, it, expect } from 'vitest';
import { buildUserActivityPipeline, parseMetadataFilters } from './userActivityQuery';

const baseQuery = { startDate: '2026-07-21', endDate: '2026-07-28', skip: 0, limit: 25 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stage = (pipeline: any[], name: string) => pipeline.find(s => Object.keys(s)[0] === name);

describe('buildUserActivityPipeline - pagination', () => {
  it('skips and limits the row facet to the window the caller asked for', () => {
    const { facetStages } = buildUserActivityPipeline({ ...baseQuery, skip: 50, limit: 25 });

    expect(facetStages.rows).toEqual(expect.arrayContaining([{ $skip: 50 }, { $limit: 25 }]));
  });

  it('counts every matching row so the client can render a page count', () => {
    const { facetStages } = buildUserActivityPipeline(baseQuery);

    expect(facetStages.total).toEqual([{ $count: 'value' }]);
  });

  it('emits one flat row per user/counter/day instead of a nested users array', () => {
    const { pipeline, facetStages } = buildUserActivityPipeline(baseQuery);

    // userEmail is joined in after this group, so the key carries userId only.
    const group = stage(pipeline, '$group');
    expect(group.$group._id).toMatchObject({ userId: '$userId', counterName: '$counterName' });
    // A second $group is what re-nested rows into users[] and blew up the payload.
    expect(pipeline.filter(s => Object.keys(s)[0] === '$group')).toHaveLength(1);
    expect(JSON.stringify(facetStages.rows)).not.toContain('$push');
  });

  it('joins the user only once per grouped row, not once per raw event', () => {
    const { pipeline } = buildUserActivityPipeline(baseQuery);

    const groupIndex = pipeline.findIndex(s => Object.keys(s)[0] === '$group');
    const lookupIndex = pipeline.findIndex(s => Object.keys(s)[0] === '$lookup');
    expect(lookupIndex).toBeGreaterThan(groupIndex);
  });

  it('survives a userId that is not an ObjectId rather than aborting the aggregation', () => {
    const { pipeline } = buildUserActivityPipeline(baseQuery);

    const convert = pipeline.find(s => s.$addFields?.userObjectId)?.$addFields.userObjectId;
    expect(convert.$convert).toMatchObject({ onError: null });
  });

  it('sorts before the facet so paging is stable across requests', () => {
    const { pipeline } = buildUserActivityPipeline(baseQuery);

    const sortIndex = pipeline.findIndex(s => Object.keys(s)[0] === '$sort');
    const groupIndex = pipeline.findIndex(s => Object.keys(s)[0] === '$group');
    expect(sortIndex).toBeGreaterThan(groupIndex);
    // date desc + count desc can tie; without a tiebreak the same row can appear on two pages.
    expect(Object.keys(pipeline[sortIndex].$sort).length).toBeGreaterThan(2);
  });

  it('orders by the whole group key so no two rows can tie', () => {
    const { pipeline } = buildUserActivityPipeline(baseQuery);

    // The group key is unique per output row, so covering all of it is what makes the order
    // total. userEmail cannot do it alone: every row whose join missed shares the '' fallback.
    const group = stage(pipeline, '$group');
    const sortKeys = Object.keys(pipeline.find(s => Object.keys(s)[0] === '$sort').$sort);
    for (const keyField of Object.keys(group.$group._id)) {
      expect(sortKeys).toContain(`_id.${keyField}`);
    }
  });
});

describe('buildUserActivityPipeline - filters', () => {
  const firstMatch = (query: Parameters<typeof buildUserActivityPipeline>[0]) =>
    buildUserActivityPipeline(query).pipeline[0].$match;

  it('keeps the counter-name search out of the browser by matching it in Mongo', () => {
    const match = firstMatch({ ...baseQuery, counterName: 'Model Started' });

    expect(match.counterName).toEqual({ $regex: 'Model Started', $options: 'i' });
  });

  it('escapes regex metacharacters in the counter-name search', () => {
    const match = firstMatch({ ...baseQuery, counterName: 'a.*b' });

    expect(match.counterName.$regex).toBe('a\\.\\*b');
  });

  it('matches the email search only after the user join has produced userEmail', () => {
    const { pipeline } = buildUserActivityPipeline({ ...baseQuery, userEmail: 'poy@' });

    const addFieldsIndex = pipeline.findIndex(s => Object.keys(s)[0] === '$addFields');
    const emailMatchIndex = pipeline.findIndex(s => s.$match?.userEmail);
    expect(emailMatchIndex).toBeGreaterThan(addFieldsIndex);
    expect(pipeline[emailMatchIndex].$match.userEmail).toEqual({ $regex: 'poy@', $options: 'i' });
  });

  it('restricts to the named events', () => {
    expect(firstMatch({ ...baseQuery, events: ['Login', 'Logout'] }).counterName).toEqual({
      $in: ['Login', 'Logout'],
    });
  });

  it('restricts to the selected organizations', () => {
    expect(firstMatch({ ...baseQuery, orgs: ['Acme'] }).userOrganization).toEqual({ $in: ['Acme'] });
  });

  it('excludes the opted-out organizations', () => {
    expect(firstMatch({ ...baseQuery, excludeOrgs: ['Personal'] }).userOrganization).toEqual({
      $nin: ['Personal'],
    });
  });
});

describe('buildUserActivityPipeline - metadata filters', () => {
  const metadataMatch = (filter: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildUserActivityPipeline({ ...baseQuery, metadataFilters: [filter as any] }).pipeline[0].$match.$and;

  it('matches an exists filter on the metadata subfield', () => {
    expect(metadataMatch({ field: 'reportId', operator: 'exists' })).toEqual([
      { 'metadata.reportId': { $exists: true, $ne: null } },
    ]);
  });

  it('matches a not_exists filter on missing and null alike', () => {
    expect(metadataMatch({ field: 'reportId', operator: 'not_exists' })).toEqual([
      { $or: [{ 'metadata.reportId': { $exists: false } }, { 'metadata.reportId': null }] },
    ]);
  });

  it('escapes a contains filter value', () => {
    expect(metadataMatch({ field: 'title', operator: 'contains', value: 'a+b' })).toEqual([
      { 'metadata.title': { $regex: 'a\\+b', $options: 'i' } },
    ]);
  });

  it('matches an equals filter against both the string and the coerced value', () => {
    expect(metadataMatch({ field: 'attempt', operator: 'equals', value: '3' })).toEqual([
      { 'metadata.attempt': { $in: ['3', 3] } },
    ]);
  });

  it('matches an in filter case-insensitively', () => {
    expect(metadataMatch({ field: 'source', operator: 'in', value: 'web, CLI' })).toEqual([
      { 'metadata.source': { $in: [/^web$/i, /^CLI$/i] } },
    ]);
  });

  it('matches an in filter against a numeric metadata field, not just its string form', () => {
    expect(metadataMatch({ field: 'credits', operator: 'in', value: '250, web' })).toEqual([
      { 'metadata.credits': { $in: [/^250$/i, 250, /^web$/i] } },
    ]);
  });

  it('applies every metadata filter, not just the first', () => {
    const { pipeline } = buildUserActivityPipeline({
      ...baseQuery,
      metadataFilters: [
        { field: 'source', operator: 'exists' },
        { field: 'title', operator: 'contains', value: 'x' },
      ],
    });

    expect(pipeline[0].$match.$and).toHaveLength(2);
  });
});

describe('parseMetadataFilters', () => {
  it('accepts a dotted metadata path', () => {
    expect(parseMetadataFilters(JSON.stringify([{ field: 'model.name', operator: 'exists' }]))).toEqual([
      { field: 'model.name', operator: 'exists', value: undefined },
    ]);
  });

  it.each(['$where', 'a.$gt', 'a b', '__proto__', ''])('rejects the unsafe field name %j', field => {
    expect(() => parseMetadataFilters(JSON.stringify([{ field, operator: 'exists' }]))).toThrow();
  });

  it('rejects an unknown operator', () => {
    expect(() => parseMetadataFilters(JSON.stringify([{ field: 'a', operator: 'drop' }]))).toThrow();
  });

  it.each([
    // Has neither a callable toString nor valueOf, so String(value) throws inside the pipeline
    // builder - past the ZodError branch, i.e. a 500 for what is a malformed request.
    { toString: 1, valueOf: 2 },
    ['a', 'b'],
  ])('rejects a non-scalar filter value %j at the boundary', value => {
    expect(() => parseMetadataFilters(JSON.stringify([{ field: 'a', operator: 'equals', value }]))).toThrow();
  });

  it('accepts the scalar value types the UI can produce', () => {
    for (const value of ['web', 3, true]) {
      expect(parseMetadataFilters(JSON.stringify([{ field: 'a', operator: 'equals', value }]))[0].value).toBe(value);
    }
  });
});

/** NUL: the driver rejects a regex pattern containing it, so the source must strip it first. */
const NUL = String.fromCharCode(0);

describe('metadata filter values that would break the driver', () => {
  const metadataMatch = (filter: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildUserActivityPipeline({ ...baseQuery, metadataFilters: [filter as any] }).pipeline[0].$match.$and;

  it('drops control characters from a contains pattern that BSON would reject', () => {
    const [condition] = metadataMatch({ field: 'title', operator: 'contains', value: `a${NUL}b` });

    expect(condition['metadata.title'].$regex).toBe('ab');
  });

  it('drops control characters from an in pattern too', () => {
    const [condition] = metadataMatch({ field: 'source', operator: 'in', value: `we${NUL}b` });

    expect(condition['metadata.source'].$in).toEqual([/^web$/i]);
  });

  it('treats an absent filter list as no filters', () => {
    expect(parseMetadataFilters(undefined)).toEqual([]);
  });
});
