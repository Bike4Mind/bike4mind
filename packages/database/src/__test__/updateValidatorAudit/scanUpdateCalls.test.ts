import { describe, expect, it } from 'vitest';
import { indexModels, normalizeWrittenPath, scanSource } from './scanUpdateCalls';

const scan = (text: string) => {
  const sources = [{ fileName: 'fixture.ts', text }];
  return scanSource('fixture.ts', text, indexModels(sources));
};

const HEADER = `
import mongoose, { model } from 'mongoose';
const Widget = model<IWidgetDocument>('Widget', WidgetSchema);
`;

describe('scanSource', () => {
  it('flags an update with no runValidators as unvalidated and reads its literal paths', () => {
    const { sites } = scan(`${HEADER}
      export const rename = (id: string) =>
        Widget.updateOne({ _id: id }, { $set: { status: 'x', 'nested.label': 'y' }, $inc: { count: 1 } });
    `);
    expect(sites).toMatchObject([
      {
        model: 'Widget',
        method: 'updateOne',
        writer: 'rename',
        gate: 'none',
        paths: ['status', 'nested.label'],
        dynamic: false,
      },
    ]);
  });

  it('treats runValidators: true as a call-site gate, inline or through setOptions', () => {
    const { sites } = scan(`${HEADER}
      Widget.updateOne({}, { $set: { a: 1 } }, { runValidators: true });
      Widget.findOneAndUpdate({}, { b: 2 }).setOptions({ runValidators: true });
      Widget.updateOne({}, { $set: { c: 3 } }, { runValidators: false });
    `);
    expect(sites.map(site => site.gate)).toEqual(['call-site', 'call-site', 'none']);
  });

  it('marks a spread, variable or pipeline payload as dynamic', () => {
    const { sites } = scan(`${HEADER}
      Widget.updateOne({}, { $set: { ...patch } });
      Widget.updateOne({}, patch);
      Widget.updateOne({}, [{ $set: { a: 1 } }]);
    `);
    expect(sites.map(site => site.dynamic)).toEqual([true, true, true]);
  });

  it('keeps paths under operators Mongoose never validates apart, on validated and unvalidated calls alike', () => {
    const { sites } = scan(`${HEADER}
      Widget.updateOne({}, { $inc: { count: 1 }, $max: { peak: 2 }, $unset: { gone: '' }, $pull: { items: 1 } });
      Widget.updateOne({}, { $set: { a: 1 }, $inc: { credits: -5 } }, { runValidators: true });
    `);
    expect(sites).toMatchObject([
      { gate: 'none', paths: [], unvalidatablePaths: ['count', 'peak'], dynamic: false },
      { gate: 'call-site', paths: ['a'], unvalidatablePaths: ['credits'], dynamic: false },
    ]);
  });

  it('flags writes through the raw driver as bypassing Mongoose', () => {
    const { sites } = scan(`${HEADER}
      Widget.collection.updateOne({}, { $set: { a: 1 } });
    `);
    expect(sites[0]).toMatchObject({ model: 'Widget', gate: 'raw-driver' });
  });

  it('resolves a repository model from the super call and reports the repository', () => {
    const { sites, repositories } = scan(`${HEADER}
      class WidgetRepository extends BaseRepository<IWidgetDocument> {
        constructor() { super(Widget); }
        bump() { return this.model.updateMany({}, { $set: { a: 1 } }); }
      }
    `);
    expect(sites[0]).toMatchObject({ model: 'Widget', writer: 'WidgetRepository.bump' });
    expect(repositories).toEqual([{ file: 'fixture.ts', className: 'WidgetRepository', model: 'Widget' }]);
  });

  it('resolves a model whose name is a same-file string const', () => {
    const { sites } = scan(`
      const ModelName = 'Gadget';
      const Gadget = model<IGadgetDocument>(ModelName, GadgetSchema);
      Gadget.updateOne({}, { a: 1 });
    `);
    expect(sites[0].model).toBe('Gadget');
  });

  it('leaves an unrecognised receiver unresolved instead of dropping the call', () => {
    const { sites } = scan(`${HEADER}
      mystery.updateOne({}, { a: 1 });
    `);
    expect(sites).toMatchObject([{ model: null, receiver: 'mystery' }]);
  });
});

describe('normalizeWrittenPath', () => {
  it.each([
    ['tags.$[elem].name', 'tags.name'],
    ['items.$.label', 'items.label'],
    ['items.0.label', 'items.label'],
    ['plain', 'plain'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeWrittenPath(raw)).toBe(expected);
  });
});
