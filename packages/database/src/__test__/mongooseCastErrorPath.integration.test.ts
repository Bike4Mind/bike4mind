import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from './createMongoServer';

/**
 * Pins what Mongoose sets `CastError.path` to, for each query shape whose path decides a status
 * code in `apps/client/server/middlewares/errorHandler.ts`.
 *
 * That middleware is reached by almost every route under `apps/client/pages/api`, and it branches
 * on a single equality: `path === '_id'` becomes a 404 logged at `warn`, anything else stays a 500
 * logged at `error` (which feeds the CloudWatch error filter). The branch is therefore only as
 * correct as an undocumented Mongoose implementation detail, and the detail is not the obvious one
 * - a cast inside a subdocument *schema* reports the LEAF name (`_id`, `ownerId`), while a cast
 * inside a plain nested object reports the DOTTED path (`nested._id`).
 *
 * The leaf form is NOT an unconditional rule, and that is the sharp edge here. It is a lazily
 * populated per-schema subpath cache: one ordinary positional or indexed update that casts the
 * dotted subpath (`{ $set: { 'members.$._id': someId } }`) makes that same query report
 * `members._id` for the rest of the process, turning its 404 into a 500. The cache is scoped to
 * the parent schema, so it cannot leak between models - `subpathCacheSchema` below demonstrates it
 * in isolation. Nothing under `apps/`, `b4m-core/` or `packages/` casts such a subpath today (the
 * only dotted `_id` uses in src are projections, an `$exists` guard, and migration scripts on the
 * raw `.collection` driver, none of which cast), so this is latent rather than live. The comment
 * on the `CastError` branch in errorHandler.ts carries the same caveat; keep the two in sync.
 *
 * This is the half of the contract that `errorHandler.test.ts` cannot cover: that suite
 * hand-constructs the CastError, so it pins how a given `path` is treated but never what Mongoose
 * actually produces. Read the two together. Keep them in sync: if a case here changes, the comment
 * on the `CastError` branch in errorHandler.ts is describing behaviour that no longer exists.
 *
 * Every value below was measured against mongoose 8.24.1, not transcribed. Casting happens
 * client-side, before the query reaches the server, so these paths reproduce without a live
 * connection too - the real server is here to keep the call shapes identical to the ones routes
 * issue, and so the update and save cases act on a document that exists.
 *
 * Adjacent but distinct: ../models/content/FabFileModel.objectIdCasting.integration.test.ts pins
 * WHICH strings cast and what a mixed `$in` does to the result set. Neither file asserts the
 * other's half - that one never looks at `path`, and this one never looks at the rows - so keep
 * both.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Built per call: sharing one Schema instance across `members` and `member` would also share the
// subpath cache described above, so a cast on one field would silently rename the other's path.
const buildMemberSchema = () => new Schema({ label: String, ownerId: Schema.Types.ObjectId }, { _id: true });

const probeSchema = new Schema({
  name: String,
  ownerId: Schema.Types.ObjectId,
  members: [buildMemberSchema()], // document array of a real subdocument schema
  member: buildMemberSchema(), // single nested subdocument schema
  // Plain nested object. Mongoose flattens this into a dotted path rather than compiling a
  // schema for it, which is the whole reason its cast failures report differently below.
  nested: { _id: Schema.Types.ObjectId, label: String },
});

const Probe = mongoose.model('CastErrorPathProbe', probeSchema);

// Its own model, so the subpath cache it deliberately poisons cannot reach the table above.
const subpathCacheSchema = new Schema({ members: [new Schema({ label: String }, { _id: true })] });
const SubpathCacheProbe = mongoose.model('CastErrorPathSubpathCacheProbe', subpathCacheSchema);

const JUNK = 'not-an-object-id';

/**
 * Returns the CastError a query rejected with. An unexpected error - a dropped connection, a mongod
 * that never booted - is rethrown as itself rather than laundered into the shape under test, and a
 * query that resolves fails loudly instead of silently pinning nothing.
 */
const captureCastError = async (run: () => Promise<unknown>): Promise<mongoose.Error.CastError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof mongoose.Error.CastError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the query to reject with a CastError, but it resolved');
};

/** The save-time counterpart. A bare CastError here would rethrow, which is the point of the test. */
const captureValidationError = async (run: () => Promise<unknown>): Promise<mongoose.Error.ValidationError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof mongoose.Error.ValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the save to reject with a ValidationError, but it resolved');
};

describe('Mongoose CastError.path semantics that errorHandler branches on', () => {
  let mongoServer: MongoMemoryServer;
  let existingId: string;
  let subpathCacheId: string;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    existingId = (await Probe.create({ name: 'seed' }))._id.toHexString();
    subpathCacheId = (await SubpathCacheProbe.create({ members: [{ label: 'a' }] }))._id.toHexString();
  });

  afterAll(async () => {
    // stop() must run even if disconnect() throws, or the mongod and its port outlive this file.
    try {
      await mongoose.disconnect();
    } finally {
      await mongoServer?.stop();
    }
  });

  // Each case's comment says which side of errorHandler's `path === '_id'` branch the value lands
  // on; the assertion deliberately pins only the path, so the status mapping stays owned by
  // errorHandler.test.ts and the two cannot drift into agreeing with each other by accident.
  const cases: { label: string; run: () => Promise<unknown>; expectedPath: string }[] = [
    // 404 side: the caller handed a route a junk resource id.
    { label: 'findById with a junk id', run: () => Probe.findById(JUNK), expectedPath: '_id' },
    { label: 'an explicit top-level _id filter', run: () => Probe.find({ _id: JUNK }), expectedPath: '_id' },
    // 404 side, and the non-obvious one: a subdocument SCHEMA reports its leaf, so a cast on a
    // nested `_id` is indistinguishable from a cast on the top-level one. See the docblock: this
    // is the fresh-process value, and a positional update on the same subpath flips it.
    { label: 'an _id inside a document array', run: () => Probe.find({ 'members._id': JUNK }), expectedPath: '_id' },
    {
      label: 'an _id inside a single nested subdocument',
      run: () => Probe.find({ 'member._id': JUNK }),
      expectedPath: '_id',
    },
    // The leaf rule is about the LEAF, not about `_id` being special - without these two, the
    // evidence above is equally consistent with a narrower "`_id` is reported bare" reading.
    {
      label: 'a non-_id leaf inside a document array',
      run: () => Probe.find({ 'members.ownerId': JUNK }),
      expectedPath: 'ownerId',
    },
    {
      label: 'a non-_id leaf inside a single nested subdocument',
      run: () => Probe.find({ 'member.ownerId': JUNK }),
      expectedPath: 'ownerId',
    },
    // 500 side: a plain object is not a schema, so the path arrives dotted and the equality misses
    // it. An `endsWith('_id')` "simplification" of errorHandler would swallow this case.
    {
      label: 'an _id inside a plain nested object',
      run: () => Probe.find({ 'nested._id': JUNK }),
      expectedPath: 'nested._id',
    },
    // 500 side: any non-`_id` path. Usually that means our own code put an uncastable value in a
    // non-lookup field, i.e. a bug - but not always. A route that lets an unvalidated query-string
    // id reach a filter lands here too, so a malformed request can fire the CloudWatch error alarm.
    {
      label: 'a non-_id ObjectId field in a filter',
      run: () => Probe.find({ ownerId: JUNK }),
      expectedPath: 'ownerId',
    },
    {
      label: 'a non-_id ObjectId field in an update payload',
      run: () => Probe.findByIdAndUpdate(existingId, { ownerId: JUNK }),
      expectedPath: 'ownerId',
    },
  ];

  it.each(cases)('reports path $expectedPath for $label', async ({ run, expectedPath }) => {
    const error = await captureCastError(run);
    // errorHandler keys off the string, not the class, so the string is what has to hold.
    expect(error.name).toBe('CastError');
    expect(error.path).toBe(expectedPath);
  });

  // Shapes adjacent to the table above. Each one also decides a status code, and none of them was
  // written down anywhere before this suite.
  describe('adjacent shapes that land on the same branch', () => {
    // FabFileModel.objectIdCasting.integration.test.ts pins that this rejection loses the valid
    // rows along with the junk one; what it costs the CALLER is the `_id` path, hence a 404.
    it('reports the leaf _id for a junk id wrapped in $in, so a bulk fetch by ids is still a 404', async () => {
      const error = await captureCastError(() => Probe.find({ _id: { $in: [JUNK] } }));
      expect(error.path).toBe('_id');
    });

    it('reports _id for a junk id in an update FILTER, not the field being written', async () => {
      const error = await captureCastError(() => Probe.findByIdAndUpdate(JUNK, { name: 'x' }));
      expect(error.path).toBe('_id');
    });

    it('reports the dotted path for a plain nested object in an update payload', async () => {
      const error = await captureCastError(() => Probe.updateOne({ _id: existingId }, { 'nested._id': JUNK }));
      expect(error.path).toBe('nested._id');
    });
  });

  // The reason the subdocument rows above say "fresh-process value" rather than stating a rule.
  describe('the subdocument leaf form is cache state, not an invariant', () => {
    it('reports the dotted path once an ordinary positional update has cast that subpath', async () => {
      const before = await captureCastError(() => SubpathCacheProbe.find({ 'members._id': JUNK }));
      expect(before.path).toBe('_id');

      // A successful, unremarkable update. It throws nothing and writes a perfectly valid id; the
      // only lasting effect is that Mongoose now has `members._id` resolved in its subpath cache.
      await SubpathCacheProbe.updateOne(
        { _id: subpathCacheId, 'members.label': 'a' },
        { $set: { 'members.$._id': new mongoose.Types.ObjectId() } }
      );

      const after = await captureCastError(() => SubpathCacheProbe.find({ 'members._id': JUNK }));
      expect(after.path).toBe('members._id');
      // Same query, same input, different status code: 404 before this update, 500 after it.
      expect(after.path).not.toBe(before.path);
    });
  });

  // The boundary of the whole contract: a bad cast on `save()` is wrapped in a ValidationError, so
  // it never reaches errorHandler's CastError branch at all and stays a 500 on `name` alone.
  describe('save-time casts never reach the branch', () => {
    it('wraps a save-time cast on _id in a ValidationError rather than surfacing a bare CastError', async () => {
      const error = await captureValidationError(() => new Probe({ _id: JUNK }).save());
      expect(error.name).toBe('ValidationError');
      // The CastError still exists, nested out of reach of a branch that reads only the top-level
      // name and path. If Mongoose ever unwrapped this, a save-time cast on an `_id`-named path
      // would start answering 404 - so this is the assertion that would catch it.
      expect(error.errors._id.name).toBe('CastError');
    });
  });
});
