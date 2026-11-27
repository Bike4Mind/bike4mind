import mongoose from 'mongoose';

// The @bike4mind/database barrel registers ~300 models, and mongoose creates every collection and
// builds every index in the background on connect. A suite that boots mongod paid for all of it
// (most of the file's run time) to use a handful of collections. Off here, so a suite gets only
// what it asks for: collections on first write, and a model's own collection and indexes on an
// explicit `await Model.init()`, which keeps meaning what createMongoServer.ts documents.
// A schema- or connection-level autoIndex/autoCreate still wins over these defaults.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

type InitModel = typeof mongoose.Model & { $init?: Promise<unknown> };

const automaticInit = mongoose.Model.init;
const requested = new WeakMap<InitModel, { automatic: Promise<unknown>; built: Promise<unknown> }>();

const MONGOOSE_LIB = /[\\/]mongoose[\\/]lib[\\/]/;

// mongoose itself calls init() for every model on registration and again on each connect; only a
// call from outside the library is a suite asking for the build.
function calledByMongoose(): boolean {
  const caller = new Error().stack?.split('\n')[3] ?? '';
  return MONGOOSE_LIB.test(caller);
}

const unset = (model: InitModel, option: 'autoIndex' | 'autoCreate') =>
  model.schema.get(option) == null && model.db.config?.[option] == null;

mongoose.Model.init = function init(this: InitModel) {
  const automatic = automaticInit.call(this) as Promise<unknown>;
  if (calledByMongoose()) return automatic;

  // Same lifetime as mongoose's own cache: it drops `$init` on disconnect, so a new connection
  // builds again and a repeat call on the same connection does not.
  const cached = requested.get(this);
  if (cached?.automatic === automatic) return cached.built;

  const built = automatic.then(async () => {
    if (unset(this, 'autoCreate')) await this.createCollection();
    if (unset(this, 'autoIndex')) await this.ensureIndexes();
    return this;
  });
  requested.set(this, { automatic, built });
  return built;
} as typeof mongoose.Model.init;
