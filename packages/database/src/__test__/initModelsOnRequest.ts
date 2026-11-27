import type { Model, Mongoose } from 'mongoose';

type InitModel = Model<unknown> & { $init?: Promise<unknown> };

const MONGOOSE_LIB = /[\\/]mongoose[\\/]lib[\\/]/;

// mongoose itself calls init() for every model on registration and again on each connect; only a
// call from outside the library is a suite asking for the build.
function calledByMongoose(): boolean {
  const caller = new Error().stack?.split('\n')[3] ?? '';
  return MONGOOSE_LIB.test(caller);
}

const unset = (model: InitModel, option: 'autoIndex' | 'autoCreate') =>
  model.schema.get(option) == null && model.db.config?.[option] == null;

/**
 * For a test setup file of a package whose suites boot a real mongod. Stops mongoose from creating
 * every registered model's collection and building every index in the background on connect.
 *
 * The `@bike4mind/database` barrel registers about 300 models, so that work was most of a
 * real-Mongo file's run time, spent on collections the file never touches. With this installed a
 * suite gets a collection on first write, and a model's own collection and indexes on an explicit
 * `await Model.init()` - the pattern createMongoServer.ts documents keeps its meaning. A schema-
 * or connection-level autoIndex/autoCreate still wins over these defaults.
 */
export function initModelsOnRequest(odm: Mongoose): void {
  odm.set('autoIndex', false);
  odm.set('autoCreate', false);

  const automaticInit = odm.Model.init;
  const requested = new WeakMap<InitModel, { automatic: Promise<unknown>; built: Promise<unknown> }>();

  odm.Model.init = function init(this: InitModel) {
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
  } as typeof odm.Model.init;
}
