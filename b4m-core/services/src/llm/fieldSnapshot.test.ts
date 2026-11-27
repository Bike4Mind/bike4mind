import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { diffFields } from './fieldSnapshot';

const NONE = new Set<string>();

describe('diffFields', () => {
  it('reports every field when there is no previous snapshot', () => {
    const { changed } = diffFields({ a: 1, b: 'x' }, undefined, NONE);
    expect(changed).toEqual({ a: 1, b: 'x' });
  });

  it('reports nothing for an unchanged document', () => {
    const doc = { a: 1, nested: { list: [1, 2] }, at: new Date(0), ref: new Types.ObjectId() };
    const { snapshot } = diffFields(doc, undefined, NONE);
    expect(diffFields(doc, snapshot, NONE).changed).toEqual({});
  });

  it('reports only the keys that changed', () => {
    const doc = { status: 'running', reply: 'a', tokens: 1 };
    const { snapshot } = diffFields(doc, undefined, NONE);
    doc.reply = 'ab';
    expect(diffFields(doc, snapshot, NONE).changed).toEqual({ reply: 'ab' });
  });

  it('detects in-place mutation of nested objects and arrays', () => {
    const doc = { replies: ['a'], promptMeta: { model: { name: 'x' } } };
    const { snapshot } = diffFields(doc, undefined, NONE);
    doc.replies.push('b');
    doc.promptMeta.model.name = 'y';
    expect(Object.keys(diffFields(doc, snapshot, NONE).changed).sort()).toEqual(['promptMeta', 'replies']);
  });

  it('compares Dates and ObjectIds by value', () => {
    const id = new Types.ObjectId();
    const { snapshot } = diffFields({ at: new Date(1000), ref: id }, undefined, NONE);
    expect(
      diffFields({ at: new Date(1000), ref: new Types.ObjectId(id.toHexString()) }, snapshot, NONE).changed
    ).toEqual({});
    const later = diffFields({ at: new Date(2000), ref: new Types.ObjectId() }, snapshot, NONE).changed;
    expect(Object.keys(later).sort()).toEqual(['at', 'ref']);
  });

  it('compares Map values by their entries', () => {
    const { snapshot } = diffFields({ m: new Map([['k', 1]]) }, undefined, NONE);
    expect(diffFields({ m: new Map([['k', 1]]) }, snapshot, NONE).changed).toEqual({});
    expect(Object.keys(diffFields({ m: new Map([['k', 2]]) }, snapshot, NONE).changed)).toEqual(['m']);
  });

  it('never returns omitted keys, even on the first diff', () => {
    const { changed, snapshot } = diffFields(
      { id: '1', deletedAt: null, a: 1 },
      undefined,
      new Set(['id', 'deletedAt'])
    );
    expect(changed).toEqual({ a: 1 });
    expect([...snapshot.keys()]).toEqual(['a']);
  });

  it('leaves removed and undefined keys out of the changes and the snapshot', () => {
    const { snapshot } = diffFields({ a: 1, b: 2 }, undefined, NONE);
    const next = diffFields({ a: 1, c: undefined } as Record<string, unknown>, snapshot, NONE);
    expect(next.changed).toEqual({});
    expect([...next.snapshot.keys()]).toEqual(['a']);
  });

  it('writes a key again once it comes back after being removed', () => {
    const first = diffFields({ a: 1, b: 2 } as Record<string, unknown>, undefined, NONE);
    const removed = diffFields({ a: 1 } as Record<string, unknown>, first.snapshot, NONE);
    expect(diffFields({ a: 1, b: 2 }, removed.snapshot, NONE).changed).toEqual({ b: 2 });
  });

  it('always reports a value that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { snapshot } = diffFields({ cyclic, big: 1n }, undefined, NONE);
    expect(Object.keys(diffFields({ cyclic, big: 1n }, snapshot, NONE).changed).sort()).toEqual(['big', 'cyclic']);
  });
});
