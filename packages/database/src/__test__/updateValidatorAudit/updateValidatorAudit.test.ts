import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../../models';
import { createMongoServer } from '../createMongoServer';
import { buildAudit, HOOK_COVERED_METHODS, renderAudit, SCHEMA_HOOK_GATES } from './buildAudit';
import { collectModelConstraints } from './constrainedPaths';
import { indexModels, scanModelsDir, scanSource } from './scanUpdateCalls';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.resolve(here, '../../models');
const baseModelFile = path.resolve(here, '../../../../../b4m-core/db-core/src/models/BaseModel.ts');

const { sites, repositories } = scanModelsDir(modelsDir);
const constraints = collectModelConstraints();

const baseSites = scanSource('BaseModel.ts', fs.readFileSync(baseModelFile, 'utf8'), indexModels([])).sites;
const baseRepositoryValidates = baseSites.length > 0 && baseSites.every(site => site.gate === 'call-site');

describe('update validator audit', () => {
  it('ties every update call and repository to a registered model', () => {
    const registered = new Set(constraints.keys());
    expect(sites.filter(site => !site.model).map(site => `${site.file}|${site.writer}|${site.method}`)).toEqual([]);
    expect(repositories.filter(repository => !repository.model).map(repository => repository.className)).toEqual([]);
    expect([...new Set(sites.map(site => site.model).filter((m): m is string => !!m && !registered.has(m)))]).toEqual(
      []
    );
    expect([...new Set(repositories.map(r => r.model).filter((m): m is string => !!m && !registered.has(m)))]).toEqual(
      []
    );
  });

  it('still finds the BaseRepository writers it reports on', () => {
    expect(baseSites.map(site => site.method).sort()).toEqual(['findOneAndUpdate', 'findOneAndUpdate', 'updateMany']);
  });

  it('matches the checked-in report', async () => {
    const audit = buildAudit({ sites, repositories, constraints, baseRepositoryValidates });
    await expect(renderAudit(audit, baseRepositoryValidates)).toMatchFileSnapshot('./updateValidatorAudit.report.md');
  });

  describe('schema-hook gates', () => {
    let server: Awaited<ReturnType<typeof createMongoServer>>;
    beforeAll(async () => {
      server = await createMongoServer();
      await mongoose.connect(server.getUri());
    });
    afterAll(async () => {
      await mongoose.disconnect();
      await server.stop();
    });

    const gated = Object.entries(SCHEMA_HOOK_GATES).flatMap(([model, paths]) => paths.map(p => [model, p] as const));

    it.each(gated)('%s.%s is an enum path', (model, gatedPath) => {
      expect(constraints.get(model)?.get(gatedPath)).toContain('enum');
    });

    const BAD = '__not-a-valid-value__';
    const newId = () => new mongoose.Types.ObjectId();
    type AnyModel = ReturnType<typeof mongoose.model>;
    type Writer = (model: AnyModel, gatedPath: string) => PromiseLike<unknown>;
    // Keyed by HOOK_COVERED_METHODS so a method added to the report must be probed here too.
    const hookedWriters: Record<(typeof HOOK_COVERED_METHODS)[number], Writer> = {
      updateOne: (model, p) => model.updateOne({ _id: newId() }, { $set: { [p]: BAD } }),
      updateMany: (model, p) => model.updateMany({ _id: newId() }, { $set: { [p]: BAD } }),
      findOneAndUpdate: (model, p) => model.findOneAndUpdate({ _id: newId() }, { $set: { [p]: BAD } }),
      findByIdAndUpdate: (model, p) => model.findByIdAndUpdate(newId(), { $set: { [p]: BAD } }),
      replaceOne: (model, p) => model.replaceOne({ _id: newId() }, { [p]: BAD }),
      findOneAndReplace: (model, p) => model.findOneAndReplace({ _id: newId() }, { [p]: BAD }),
    };
    const hookedCases = gated.flatMap(([model, p]) => HOOK_COVERED_METHODS.map(method => [model, p, method] as const));

    it.each(hookedCases)(
      '%s.%s rejects an out-of-enum value through %s without runValidators',
      async (model, p, method) => {
        await expect(hookedWriters[method](mongoose.model(model), p)).rejects.toThrow(mongoose.Error.ValidationError);
      }
    );

    it.each(gated)('%s.%s is not guarded against bulkWrite, which the report lists as a bypass', async (model, p) => {
      const write = mongoose
        .model(model)
        .bulkWrite([{ updateOne: { filter: { _id: newId() }, update: { $set: { [p]: BAD } } } }]);
      await expect(write).resolves.toBeDefined();
    });
  });
});
