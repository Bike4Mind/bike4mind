import { describe, it, expect } from 'vitest';
import {
  buildFabFileSearchQuery,
  buildOwnershipConditions,
  escapeRegex,
  getMimeTypeFilter,
  FabFileSearchParams,
} from '../queries/fabFileSearchQuery';

function makeParams(overrides: Partial<FabFileSearchParams> = {}): FabFileSearchParams {
  return {
    userId: 'user123',
    search: '',
    filters: {},
    pagination: { page: 1, limit: 20 },
    order: { by: 'createdAt', direction: 'desc' },
    useDocumentDB: false,
    ...overrides,
  };
}

describe('buildFabFileSearchQuery', () => {
  // ── 1. Stop-word filtering ──────────────────────────────────────────
  describe('stop-word filtering', () => {
    it('filters stop words from text search terms', () => {
      const result = buildFabFileSearchQuery(
        makeParams({
          search: 'Acme vs Globex competitive positioning',
          options: { textSearch: true },
        })
      );

      // Find the $or condition that contains text field matches
      const andConditions = result.filter.$and as object[];
      const textOr = andConditions.find(
        c =>
          '$or' in c &&
          Array.isArray((c as { $or: object[] }).$or) &&
          (c as { $or: Record<string, unknown>[] }).$or.some(item => 'fileName' in item)
      ) as { $or: Record<string, unknown>[] };

      expect(textOr).toBeDefined();

      // Each term produces 3 field conditions (fileName, tags.name, notes)
      // Expected terms: Acme, Globex, competitive, positioning (not "vs")
      const fieldConditions = textOr.$or;
      expect(fieldConditions).toHaveLength(4 * 3); // 4 terms x 3 fields

      const fileNameTerms = fieldConditions
        .filter(c => 'fileName' in c)
        .map(c => (c.fileName as { $regex: string }).$regex);

      expect(fileNameTerms).toEqual(['Acme', 'Globex', 'competitive', 'positioning']);
    });

    it('emits no text-search $or when query consists entirely of stop words', () => {
      const result = buildFabFileSearchQuery(
        makeParams({
          search: 'the is a of and to',
          options: { textSearch: true },
        })
      );

      // No fileName regex on the base filter (textSearch path is taken)
      expect(result.filter.fileName).toBeUndefined();

      // No text-search $or in $and either - every term was filtered out
      const andConditions = (result.filter.$and as object[] | undefined) ?? [];
      const textOr = andConditions.find(
        c =>
          '$or' in c &&
          Array.isArray((c as { $or: object[] }).$or) &&
          (c as { $or: Record<string, unknown>[] }).$or.some(item => 'fileName' in item)
      );
      expect(textOr).toBeUndefined();
    });
  });

  // ── 2. Regex escaping ──────────────────────────────────────────────
  describe('escapeRegex', () => {
    it('escapes + character', () => {
      expect(escapeRegex('foo+bar')).toBe('foo\\+bar');
    });

    it('escapes * and . characters', () => {
      expect(escapeRegex('test*.js')).toBe('test\\*\\.js');
    });

    it('escapes ? character', () => {
      expect(escapeRegex('what?')).toBe('what\\?');
    });

    it('escapes ^ and $ anchors', () => {
      expect(escapeRegex('^start$')).toBe('\\^start\\$');
    });

    it('escapes parentheses', () => {
      expect(escapeRegex('(group)')).toBe('\\(group\\)');
    });

    it('escapes square brackets', () => {
      expect(escapeRegex('[abc]')).toBe('\\[abc\\]');
    });

    it('escapes curly braces', () => {
      expect(escapeRegex('a{1,3}')).toBe('a\\{1,3\\}');
    });

    it('escapes pipe (alternation)', () => {
      expect(escapeRegex('a|b')).toBe('a\\|b');
    });

    it('escapes backslash', () => {
      expect(escapeRegex('path\\to')).toBe('path\\\\to');
    });

    it('neutralizes a ReDoS-style payload', () => {
      // Without escaping, this nested-quantifier pattern would be a catastrophic-backtracking
      // payload. After escaping, every metacharacter is literal - no quantifier remains.
      const payload = '(a+)+$';
      const escaped = escapeRegex(payload);
      expect(escaped).toBe('\\(a\\+\\)\\+\\$');
      // Must compile and match only the literal string
      const re = new RegExp(escaped);
      expect(re.test('(a+)+$')).toBe(true);
      expect(re.test('aaaaaaaaaa')).toBe(false);
    });
  });

  // ── 3. MIME type mapping ───────────────────────────────────────────
  describe('getMimeTypeFilter', () => {
    it('maps text to text/plain', () => {
      expect(getMimeTypeFilter('text')).toEqual({ mimeType: 'text/plain' });
    });

    it('maps pdf to application/pdf', () => {
      expect(getMimeTypeFilter('pdf')).toEqual({ mimeType: 'application/pdf' });
    });

    it('maps url to type URL', () => {
      expect(getMimeTypeFilter('url')).toEqual({ type: 'URL' });
    });

    it('maps image to regex ^image/', () => {
      expect(getMimeTypeFilter('image')).toEqual({ mimeType: { $regex: '^image/' } });
    });

    it('maps excel to $in with two mime types', () => {
      const result = getMimeTypeFilter('excel');
      expect(result).toEqual({
        mimeType: {
          $in: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        },
      });
    });

    it('maps word to docx mime type', () => {
      expect(getMimeTypeFilter('word')).toEqual({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    });

    it('maps json to application/json', () => {
      expect(getMimeTypeFilter('json')).toEqual({ mimeType: 'application/json' });
    });

    it('maps csv to text/csv', () => {
      expect(getMimeTypeFilter('csv')).toEqual({ mimeType: 'text/csv' });
    });

    it('maps markdown to text/markdown', () => {
      expect(getMimeTypeFilter('markdown')).toEqual({ mimeType: 'text/markdown' });
    });

    it('maps code to CODE_FILE_MIME_TYPES $in', () => {
      const result = getMimeTypeFilter('code');
      expect(result).toHaveProperty('mimeType');
      expect((result.mimeType as { $in: string[] }).$in).toBeDefined();
      expect(Array.isArray((result.mimeType as { $in: string[] }).$in)).toBe(true);
    });
  });

  // ── 4. Ownership - default (owned only) ───────────────────────────
  describe('ownership - default (owned only)', () => {
    it('sets userId equal to given userId when no sharing flags', () => {
      const result = buildFabFileSearchQuery(makeParams());
      expect(result.filter.userId).toBe('user123');
    });
  });

  // ── 5. Ownership - shared ─────────────────────────────────────────
  describe('ownership - shared', () => {
    it('sets userId $ne and users $elemMatch when shared is true', () => {
      const result = buildFabFileSearchQuery(makeParams({ filters: { shared: true } }));
      expect(result.filter.userId).toEqual({ $ne: 'user123' });
      expect(result.filter.users).toEqual({
        $elemMatch: {
          userId: 'user123',
          permissions: { $in: ['read', 'write'] },
        },
      });
    });
  });

  // ── 6. Ownership - curated ────────────────────────────────────────
  describe('ownership - curated', () => {
    it('sets userId and adds curated-notebook tag condition', () => {
      const result = buildFabFileSearchQuery(makeParams({ filters: { curated: true } }));
      expect(result.filter.userId).toBe('user123');

      const andConditions = result.filter.$and as object[];
      const curatedCondition = andConditions.find(c => 'tags' in c && JSON.stringify(c).includes('curated-notebook'));
      expect(curatedCondition).toEqual({
        tags: { $elemMatch: { name: 'curated-notebook' } },
      });
    });
  });

  // ── 7. Ownership - includeShared with groups and dataLakeTags ─────
  describe('ownership - includeShared', () => {
    it('adds $or with ownership conditions including groups and dataLakeTags', () => {
      const result = buildFabFileSearchQuery(
        makeParams({
          options: {
            includeShared: true,
            userGroups: ['group1', 'group2'],
            dataLakeTags: ['datalake:public'],
          },
        })
      );

      // userId should NOT be set on baseFilter (ownership is in $and.$or)
      expect(result.filter.userId).toBeUndefined();

      const andConditions = result.filter.$and as Record<string, unknown>[];
      const ownershipOr = andConditions.find(
        c =>
          '$or' in c &&
          Array.isArray(c.$or) &&
          (c.$or as Record<string, unknown>[]).some(item => 'userId' in item && item.userId === 'user123')
      ) as { $or: object[] };

      expect(ownershipOr).toBeDefined();
      // Should have 4 conditions: owned, user-shared, group-shared, data-lake
      expect(ownershipOr.$or).toHaveLength(4);
    });
  });

  // ── 8. buildOwnershipConditions ───────────────────────────────────
  describe('buildOwnershipConditions', () => {
    it('returns 2 conditions with no options', () => {
      const conditions = buildOwnershipConditions('user1');
      expect(conditions).toHaveLength(2);
    });

    it('returns 3 conditions with userGroups', () => {
      const conditions = buildOwnershipConditions('user1', { userGroups: ['g1'] });
      expect(conditions).toHaveLength(3);
    });

    it('returns 3 conditions with dataLakeTags', () => {
      const conditions = buildOwnershipConditions('user1', { dataLakeTags: ['dl:tag'] });
      expect(conditions).toHaveLength(3);
    });

    it('returns 4 conditions with both userGroups and dataLakeTags', () => {
      const conditions = buildOwnershipConditions('user1', {
        userGroups: ['g1'],
        dataLakeTags: ['dl:tag'],
      });
      expect(conditions).toHaveLength(4);
    });

    // ── Cross-tenant leak guard ──────────────────────────────
    // OPEN prefixes (static registry: opti:/acme:) are an ownership bypass by design
    // (shared KB). SCOPED prefixes (dynamic, user-created lakes) must be matched ONLY
    // within owner/org access, so a user who creates a lake with a COLLIDING prefix
    // can never read another tenant's files.
    describe('scoped vs open tag prefixes', () => {
      it('OPEN prefix is a bare ownership-bypass $or arm (no access AND)', () => {
        const conditions = buildOwnershipConditions('user1', { dataLakeTagPrefixes: ['opti:'] });
        // [owned, shared, openPrefix]
        const openArm = conditions[conditions.length - 1] as Record<string, unknown>;
        expect(openArm).toEqual({ tags: { $elemMatch: { name: { $regex: /^(opti:)/ } } } });
        expect('$and' in openArm).toBe(false);
      });

      it('SCOPED prefix is ANDed with base access — never a bare bypass', () => {
        const conditions = buildOwnershipConditions('user1', {
          userGroups: ['g1'],
          scopedTagPrefixes: ['acme:'],
        });
        const scopedArm = conditions[conditions.length - 1] as { $and?: object[] };
        expect(scopedArm.$and).toBeDefined();
        // arm[0] = the prefix regex; arm[1] = an $or of the SAME base access conditions
        // (owned / shared / group) - so a colliding prefix can't bypass ownership.
        const [prefixCond, accessCond] = scopedArm.$and as [Record<string, unknown>, { $or: object[] }];
        expect(prefixCond).toEqual({ tags: { $elemMatch: { name: { $regex: /^(acme:)/ } } } });
        expect(accessCond.$or).toEqual([
          { userId: 'user1' },
          { users: { $elemMatch: { userId: 'user1', permissions: { $in: ['read', 'write'] } } } },
          { groups: { $elemMatch: { groupId: { $in: ['g1'] }, permissions: { $in: ['read', 'write'] } } } },
        ]);
      });

      it('keeps open and scoped arms distinct when both are present', () => {
        const conditions = buildOwnershipConditions('user1', {
          dataLakeTagPrefixes: ['opti:'], // open
          scopedTagPrefixes: ['acme:'], // scoped
        });
        // owned, shared, open-arm, scoped-arm (RegExp can't be JSON-serialized, so read .source)
        expect(conditions).toHaveLength(4);
        const openArm = conditions[2] as { $and?: unknown; tags: { $elemMatch: { name: { $regex: RegExp } } } };
        expect(openArm.$and).toBeUndefined();
        expect(openArm.tags.$elemMatch.name.$regex.source).toBe('^(opti:)');
        const scopedArm = conditions[3] as { $and: [{ tags: { $elemMatch: { name: { $regex: RegExp } } } }, object] };
        expect(scopedArm.$and).toBeDefined();
        expect(scopedArm.$and[0].tags.$elemMatch.name.$regex.source).toBe('^(acme:)');
      });
    });

    // ── Single-lake scope ────────────────────────────────────
    // A single-lake view (GET /api/data-lakes/:id/articles) must return ONLY that lake's
    // files. Without restrictToDataLake the bare {userId} arm broadened results to ALL
    // owned files, so every lake's viewer showed unrelated files under "Uncategorized".
    describe('restrictToDataLake (single-lake scope)', () => {
      it('omits the broad owner/shared arms, keeping only the lake meta-tag arm', () => {
        const conditions = buildOwnershipConditions('user1', {
          dataLakeTags: ['datalake:acme'],
          restrictToDataLake: true,
        });
        expect(conditions).toEqual([{ tags: { $elemMatch: { name: { $in: ['datalake:acme'] } } } }]);
        expect(conditions.some(c => 'userId' in (c as Record<string, unknown>))).toBe(false);
      });

      it('still ANDs a scoped prefix with base access (ownership never bypassed)', () => {
        const conditions = buildOwnershipConditions('user1', {
          dataLakeTags: ['datalake:acme'],
          scopedTagPrefixes: ['acme:'],
          restrictToDataLake: true,
        });
        // [meta-tag arm, scoped-prefix arm] - still no bare ownership arms.
        expect(conditions).toHaveLength(2);
        expect(conditions.some(c => 'userId' in (c as Record<string, unknown>))).toBe(false);
        const scopedArm = conditions[1] as { $and: [Record<string, unknown>, { $or: object[] }] };
        expect(scopedArm.$and[1].$or).toEqual([
          { userId: 'user1' },
          { users: { $elemMatch: { userId: 'user1', permissions: { $in: ['read', 'write'] } } } },
        ]);
      });

      it('default (no flag) still keeps the broad owner/shared arms', () => {
        const conditions = buildOwnershipConditions('user1', { dataLakeTags: ['datalake:acme'] });
        expect(conditions).toHaveLength(3); // owned, shared, meta-tag
        expect(conditions[0]).toEqual({ userId: 'user1' });
      });

      it('throws (not an empty $or) when restrictToDataLake is set with no tags/prefixes', () => {
        // Dropping the broad arms with no lake arm would build `{ $or: [] }`, which MongoDB
        // rejects at query time. Fail fast with a descriptive error instead.
        expect(() => buildOwnershipConditions('user1', { restrictToDataLake: true })).toThrow(
          /requires at least one of dataLakeTags or scopedTagPrefixes/
        );
        // An empty-string prefix doesn't count (validPrefixes filters it), so still throws.
        expect(() =>
          buildOwnershipConditions('user1', { restrictToDataLake: true, scopedTagPrefixes: [''] })
        ).toThrow();
      });
    });
  });

  // ── 9. Session-summary exclusion ──────────────────────────────────
  describe('session-summary exclusion', () => {
    it('always includes session exclusion $or in andConditions', () => {
      const result = buildFabFileSearchQuery(makeParams());
      const andConditions = result.filter.$and as object[];

      const sessionExclusion = andConditions.find(
        c => '$or' in c && JSON.stringify(c).includes('sessionId') && JSON.stringify(c).includes('curated-notebook')
      );
      expect(sessionExclusion).toEqual({
        $or: [
          { sessionId: { $eq: null } },
          { sessionId: { $exists: false } },
          { tags: { $elemMatch: { name: 'curated-notebook' } } },
        ],
      });
    });
  });

  // ── 10. DocumentDB sort ───────────────────────────────────────────
  describe('DocumentDB sort', () => {
    it('uses fileNameLower and null collation for DocumentDB', () => {
      const result = buildFabFileSearchQuery(
        makeParams({
          order: { by: 'fileName', direction: 'asc' },
          useDocumentDB: true,
        })
      );
      expect(result.sort).toEqual({ fileNameLower: 1 });
      expect(result.collation).toBeNull();
    });
  });

  // ── 11. MongoDB sort ──────────────────────────────────────────────
  describe('MongoDB sort', () => {
    it('uses fileName and locale collation for MongoDB', () => {
      const result = buildFabFileSearchQuery(
        makeParams({
          order: { by: 'fileName', direction: 'asc' },
          useDocumentDB: false,
        })
      );
      expect(result.sort).toEqual({ fileName: 1 });
      expect(result.collation).toEqual({ locale: 'en' });
    });
  });

  // ── 12. Pagination ────────────────────────────────────────────────
  describe('pagination', () => {
    it('computes skip and limit+1 for hasMore detection', () => {
      const result = buildFabFileSearchQuery(makeParams({ pagination: { page: 3, limit: 20 } }));
      expect(result.skip).toBe(40);
      expect(result.limit).toBe(21);
    });
  });

  // ── 13. Tag filter ────────────────────────────────────────────────
  describe('tag filter', () => {
    it('adds $elemMatch with case-insensitive regex for tags', () => {
      const result = buildFabFileSearchQuery(makeParams({ filters: { tags: ['research', 'robotics'] } }));
      const andConditions = result.filter.$and as Record<string, unknown>[];
      const tagCondition = andConditions.find(
        c => 'tags' in c && JSON.stringify(c).includes('$elemMatch') && JSON.stringify(c).includes('$in')
      ) as { tags: { $elemMatch: { name: { $in: RegExp[] } } } };

      expect(tagCondition).toBeDefined();
      const patterns = tagCondition.tags.$elemMatch.name.$in;
      expect(patterns).toHaveLength(2);
      expect(patterns[0]).toBeInstanceOf(RegExp);
      expect(patterns[0].flags).toBe('i');
      expect(patterns[0].test('Research')).toBe(true);
      expect(patterns[1].test('Robotics')).toBe(true);
    });
  });

  // ── 14. fileIds exclusion ─────────────────────────────────────────
  describe('fileIds exclusion', () => {
    it('adds _id $nin filter for excluded file IDs', () => {
      const result = buildFabFileSearchQuery(makeParams({ filters: { fileIds: ['id1', 'id2'] } }));
      expect(result.filter._id).toEqual({ $nin: ['id1', 'id2'] });
    });
  });

  // ── 14b. restrictToFileIds allow-list ─────────────────────────────
  describe('restrictToFileIds allow-list', () => {
    it('adds _id $in filter (never $nin) for the allow-list', () => {
      const result = buildFabFileSearchQuery(makeParams({ filters: { restrictToFileIds: ['id1', 'id2'] } }));
      expect(result.filter._id).toEqual({ $in: ['id1', 'id2'] });
    });

    it('an empty allow-list restricts to nothing ($in: []) rather than dropping the restriction', () => {
      const result = buildFabFileSearchQuery(makeParams({ filters: { restrictToFileIds: [] } }));
      expect(result.filter._id).toEqual({ $in: [] });
    });

    it('leaves _id unset when the allow-list is undefined', () => {
      const result = buildFabFileSearchQuery(makeParams({ filters: {} }));
      expect(result.filter._id).toBeUndefined();
    });

    it('composes with the fileIds exclusion so both apply', () => {
      const result = buildFabFileSearchQuery(
        makeParams({ filters: { fileIds: ['ex1'], restrictToFileIds: ['id1', 'id2'] } })
      );
      expect(result.filter._id).toEqual({ $nin: ['ex1'], $in: ['id1', 'id2'] });
    });

    it('applies alongside the owner filter when includeShared is false', () => {
      const result = buildFabFileSearchQuery(makeParams({ filters: { restrictToFileIds: ['id1'] } }));
      expect(result.filter.userId).toBe('user123');
      expect(result.filter._id).toEqual({ $in: ['id1'] });
    });

    it('skipOwnership drops the ownership predicate when the allow-list is present', () => {
      const result = buildFabFileSearchQuery(
        makeParams({ filters: { restrictToFileIds: ['id1'] }, options: { skipOwnership: true } })
      );
      expect(result.filter.userId).toBeUndefined();
      expect(result.filter._id).toEqual({ $in: ['id1'] });
    });

    it('skipOwnership is IGNORED without an allow-list - it can never widen an unrestricted search', () => {
      const result = buildFabFileSearchQuery(makeParams({ options: { skipOwnership: true } }));
      expect(result.filter.userId).toBe('user123');
      expect(result.filter._id).toBeUndefined();
    });
  });

  // ── 15. fileSize sort ─────────────────────────────────────────────
  describe('fileSize sort', () => {
    it('adds fileSize existence check to andConditions', () => {
      const result = buildFabFileSearchQuery(makeParams({ order: { by: 'fileSize', direction: 'desc' } }));
      const andConditions = result.filter.$and as object[];
      const fileSizeCondition = andConditions.find(c => '$or' in c && JSON.stringify(c).includes('fileSize'));
      expect(fileSizeCondition).toEqual({
        $or: [{ fileSize: { $exists: true, $ne: null } }, { fileSize: 0 }],
      });
    });
  });

  // ── 16. Empty search with textSearch ──────────────────────────────
  describe('empty search with textSearch', () => {
    it('does not add text condition for empty search string', () => {
      const result = buildFabFileSearchQuery(makeParams({ search: '', options: { textSearch: true } }));

      // Should only have session exclusion in andConditions
      const andConditions = result.filter.$and as object[];
      const textCondition = andConditions.find(
        c => '$or' in c && (c as { $or: Record<string, unknown>[] }).$or.some(item => 'fileName' in item)
      );
      expect(textCondition).toBeUndefined();

      // No fileName on base filter either
      expect(result.filter.fileName).toBeUndefined();
    });
  });

  // ── 17. dataLakeTagPrefixes ───────────────────────────────────────
  describe('dataLakeTagPrefixes', () => {
    it('adds prefix regex condition when valid prefixes are passed', () => {
      const conditions = buildOwnershipConditions('user1', {
        dataLakeTagPrefixes: ['opti:', 'acme:'],
      });
      const prefixCondition = conditions.find(c => JSON.stringify(c).includes('$regex')) as {
        tags: { $elemMatch: { name: { $regex: RegExp } } };
      };
      expect(prefixCondition).toBeDefined();
      const regex = prefixCondition.tags.$elemMatch.name.$regex;
      expect(regex.test('opti:foo')).toBe(true);
      expect(regex.test('acme:bar')).toBe(true);
      expect(regex.test('other:baz')).toBe(false);
    });

    it('filters out empty prefixes', () => {
      const conditions = buildOwnershipConditions('user1', {
        dataLakeTagPrefixes: ['', '  '],
      });
      const prefixCondition = conditions.find(c => JSON.stringify(c).includes('$regex'));
      expect(prefixCondition).toBeUndefined();
    });

    it('filters out non-colon-terminated prefixes', () => {
      const conditions = buildOwnershipConditions('user1', {
        dataLakeTagPrefixes: ['opti', 'acme'],
      });
      const prefixCondition = conditions.find(c => JSON.stringify(c).includes('$regex'));
      expect(prefixCondition).toBeUndefined();
    });

    it('escapes regex special characters in prefixes', () => {
      const conditions = buildOwnershipConditions('user1', {
        dataLakeTagPrefixes: ['a.b:'],
      });
      const prefixCondition = conditions.find(c => JSON.stringify(c).includes('$regex')) as {
        tags: { $elemMatch: { name: { $regex: RegExp } } };
      };
      expect(prefixCondition).toBeDefined();
      const regex = prefixCondition.tags.$elemMatch.name.$regex;
      expect(regex.test('a.b:foo')).toBe(true);
      expect(regex.test('axb:foo')).toBe(false);
    });

    it('threads dataLakeTagPrefixes through buildFabFileSearchQuery when includeShared is true', () => {
      const result = buildFabFileSearchQuery(
        makeParams({
          options: {
            includeShared: true,
            dataLakeTagPrefixes: ['opti:'],
          },
        })
      );
      const andConditions = result.filter.$and as Record<string, unknown>[];
      const ownershipBlock = andConditions.find(c => '$or' in c && JSON.stringify(c).includes('$regex'));
      expect(ownershipBlock).toBeDefined();
    });
  });

  // ── 18. excludeContent ────────────────────────────────────────────
  describe('excludeContent', () => {
    it('returns excludeContent: true when option is set', () => {
      const result = buildFabFileSearchQuery(makeParams({ options: { excludeContent: true } }));
      expect(result.excludeContent).toBe(true);
    });

    it('returns excludeContent: undefined when option is not set', () => {
      const result = buildFabFileSearchQuery(makeParams());
      expect(result.excludeContent).toBeUndefined();
    });

    it('returns excludeContent: false when explicitly disabled', () => {
      const result = buildFabFileSearchQuery(makeParams({ options: { excludeContent: false } }));
      expect(result.excludeContent).toBe(false);
    });
  });

  // ── 19. Retrieval exclusion (generic marker + vectorized filter) ──────
  // The tutor RAG bug was retrieval disagreeing with the document-listing predicate;
  // these lock the query-builder half. The matcher must reproduce a leading-marker,
  // word-boundary match (NOT a bare prefix) using a DocumentDB-safe regex (no `\b`),
  // and be a byte-identical no-op when unset.
  describe('retrieval exclusion', () => {
    const findMarkerClause = (result: ReturnType<typeof buildFabFileSearchQuery>) =>
      ((result.filter.$and as Record<string, unknown>[] | undefined) ?? []).find(c => 'fileNameLower' in c) as
        { fileNameLower: { $not: RegExp } } | undefined;
    const hasVectorizedClause = (result: ReturnType<typeof buildFabFileSearchQuery>) =>
      ((result.filter.$and as Record<string, unknown>[] | undefined) ?? []).some(
        c => JSON.stringify(c) === JSON.stringify({ vectorized: true })
      );

    it('adds a fileNameLower $not clause with a DocumentDB-safe regex when markers are set', () => {
      const result = buildFabFileSearchQuery(makeParams({ options: { excludeFilenameMarkers: ['MARK'] } }));
      const clause = findMarkerClause(result);
      expect(clause).toBeDefined();
      const re = clause!.fileNameLower.$not;
      expect(re).toBeInstanceOf(RegExp);
      // Markers are lowercased at the call site (matched against the pre-lowered fileNameLower);
      // NO `i` flag (index-safe) and NO `\b` (DocumentDB regex subset).
      expect(re.source).toBe('^(mark)($|[^a-z0-9_])');
      expect(re.flags).toBe('');
    });

    it('word-boundary: excludes "MARK - x.pdf" but NOT "MARKdown.pdf"', () => {
      const result = buildFabFileSearchQuery(makeParams({ options: { excludeFilenameMarkers: ['MARK'] } }));
      const re = findMarkerClause(result)!.fileNameLower.$not;
      // The clause is `$not re`, so a filename the regex MATCHES is the one that gets excluded.
      expect(re.test('mark - x.pdf')).toBe(true); // excluded
      expect(re.test('markdown.pdf')).toBe(false); // NOT excluded (word char after marker)
    });

    it('is case-insensitive via pre-lowered field (matches "mark - x")', () => {
      const result = buildFabFileSearchQuery(makeParams({ options: { excludeFilenameMarkers: ['MARK'] } }));
      const re = findMarkerClause(result)!.fileNameLower.$not;
      expect(re.test('mark - notes.pdf')).toBe(true);
    });

    it('escapes regex metacharacters and alternates multiple markers', () => {
      const result = buildFabFileSearchQuery(makeParams({ options: { excludeFilenameMarkers: ['MARK', 'a.b'] } }));
      const re = findMarkerClause(result)!.fileNameLower.$not;
      expect(re.source).toBe('^(mark|a\\.b)($|[^a-z0-9_])');
      expect(re.test('a.b file.pdf')).toBe(true);
      expect(re.test('axb file.pdf')).toBe(false); // '.' is literal, not wildcard
    });

    it('adds a {vectorized:true} clause when vectorizedOnly is set', () => {
      const result = buildFabFileSearchQuery(makeParams({ options: { vectorizedOnly: true } }));
      expect(hasVectorizedClause(result)).toBe(true);
    });

    it('does NOT clobber a plain-search fileName filter (markers push to $and, not baseFilter)', () => {
      const result = buildFabFileSearchQuery(
        makeParams({ search: 'report', options: { excludeFilenameMarkers: ['MARK'] } })
      );
      // The plain-search path sets baseFilter.fileName; the marker clause must live in $and so
      // both survive (the anti-Object.assign invariant the builder comment warns about).
      expect(result.filter.fileName).toEqual({ $regex: 'report', $options: 'i' });
      expect(findMarkerClause(result)).toBeDefined();
    });

    // Byte-identical no-op guard: unset / empty / whitespace-only markers must not change
    // the query at all (prevents an `^`-matches-everything blackout AND regressing all callers).
    it('is a byte-identical no-op when markers are unset', () => {
      const baseline = buildFabFileSearchQuery(makeParams());
      const withUnset = buildFabFileSearchQuery(makeParams({ options: {} }));
      expect(JSON.stringify(withUnset.filter)).toBe(JSON.stringify(baseline.filter));
      expect(findMarkerClause(withUnset)).toBeUndefined();
      expect(hasVectorizedClause(withUnset)).toBe(false);
    });

    it.each([[[]], [['']], [['  ']], [['', '  ']]])(
      'is a byte-identical no-op for empty/whitespace markers %j',
      markers => {
        const baseline = buildFabFileSearchQuery(makeParams());
        const result = buildFabFileSearchQuery(makeParams({ options: { excludeFilenameMarkers: markers } }));
        expect(JSON.stringify(result.filter)).toBe(JSON.stringify(baseline.filter));
        expect(findMarkerClause(result)).toBeUndefined();
      }
    );

    it('does not set vectorized clause when vectorizedOnly is false/unset', () => {
      expect(hasVectorizedClause(buildFabFileSearchQuery(makeParams({ options: { vectorizedOnly: false } })))).toBe(
        false
      );
      expect(hasVectorizedClause(buildFabFileSearchQuery(makeParams()))).toBe(false);
    });
  });
});
