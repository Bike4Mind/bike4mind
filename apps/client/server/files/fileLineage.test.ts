import { describe, it, expect, vi } from 'vitest';
import type { GeneratedAssetLineageEntry, IFabFileDocument } from '@bike4mind/common';
import { buildFileLineage, LINEAGE_MAX_DEPTH, LINEAGE_MAX_NODES, type FileLineageDeps } from './fileLineage';

const hexId = (n: number) => n.toString(16).padStart(24, '0');

const makeFile = (id: string, derivedFrom?: GeneratedAssetLineageEntry[]) =>
  ({
    id,
    fileName: `file-${id}`,
    mimeType: 'image/png',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    fileUrl: `https://files.example.invalid/${id}`,
    sourceMetadata: { generation: { generator: 'image', provider: 'p', prompt: 'a prompt', request: { id } } },
    derivedFrom,
  }) as unknown as IFabFileDocument;

/** A store where every file is readable unless listed in `hidden`. */
const depsFor = (files: IFabFileDocument[], { hidden = [] as string[], children = [] as string[] } = {}) => {
  const byId = new Map(files.map(file => [file.id, file]));
  const readAccessible = vi.fn(async (ids: string[]) =>
    ids.filter(id => !hidden.includes(id)).flatMap(id => byId.get(id) ?? [])
  );
  const findChildIds = vi.fn(async (_id: string, _page: { limit: number; skip: number }) => children);
  return { readAccessible, findChildIds } satisfies FileLineageDeps;
};

describe('buildFileLineage', () => {
  it('walks a chain no deeper than LINEAGE_MAX_DEPTH and flags the cut', async () => {
    const files = Array.from({ length: LINEAGE_MAX_DEPTH + 5 }, (_, n) =>
      makeFile(hexId(n), n === LINEAGE_MAX_DEPTH + 4 ? undefined : [{ fileId: hexId(n + 1), role: 'variation_of' }])
    );
    const deps = depsFor(files);

    const lineage = await buildFileLineage(files[0], deps);

    expect(lineage.ancestors.map(node => node.depth)).toEqual(
      Array.from({ length: LINEAGE_MAX_DEPTH + 1 }, (_, n) => n)
    );
    expect(lineage.truncated).toBe(true);
    expect(deps.readAccessible).toHaveBeenCalledTimes(LINEAGE_MAX_DEPTH);
  });

  it('caps the node count on a wide trail', async () => {
    const inputs = Array.from({ length: LINEAGE_MAX_NODES + 4 }, (_, n) => makeFile(hexId(n + 1)));
    const root = makeFile(
      hexId(0),
      inputs.map(input => ({ fileId: input.id, role: 'reference' }))
    );

    const lineage = await buildFileLineage(root, depsFor([root, ...inputs]));

    expect(lineage.ancestors).toHaveLength(LINEAGE_MAX_NODES);
    expect(lineage.edges).toHaveLength(LINEAGE_MAX_NODES - 1);
    expect(lineage.truncated).toBe(true);
  });

  it('terminates on a cycle and keeps both edges of a diamond', async () => {
    const [root, left, right, top] = [0, 1, 2, 3].map(hexId);
    const files = [
      makeFile(root, [
        { fileId: left, role: 'first_frame' },
        { fileId: right, role: 'last_frame' },
      ]),
      makeFile(left, [{ fileId: top, role: 'variation_of' }]),
      makeFile(right, [{ fileId: top, role: 'style' }]),
      makeFile(top, [{ fileId: root, role: 'extend_of' }]),
    ];

    const lineage = await buildFileLineage(files[0], depsFor(files));

    expect(lineage.ancestors.map(node => node.fileId)).toEqual([root, left, right, top]);
    expect(lineage.edges).toEqual(
      expect.arrayContaining([
        { parentId: top, childId: left, role: 'variation_of' },
        { parentId: top, childId: right, role: 'style' },
      ])
    );
    expect(lineage.truncated).toBe(false);
  });

  it('redacts an unreadable ancestor without reading its inputs', async () => {
    const [root, hidden, behindHidden] = [0, 1, 2].map(hexId);
    const files = [
      makeFile(root, [{ fileId: hidden, role: 'edit_source' }]),
      makeFile(hidden, [{ fileId: behindHidden, role: 'mask' }]),
      makeFile(behindHidden),
    ];
    const deps = depsFor(files, { hidden: [hidden] });

    const lineage = await buildFileLineage(files[0], deps);

    expect(lineage.ancestors[1]).toEqual({ fileId: hidden, depth: 1, redacted: true });
    expect(lineage.ancestors).toHaveLength(2);
    expect(deps.readAccessible).not.toHaveBeenCalledWith([behindHidden]);
  });

  it('reads a non-generated ancestor with null generation fields', async () => {
    const upload = { ...makeFile(hexId(1)), sourceMetadata: undefined } as unknown as IFabFileDocument;
    const root = makeFile(hexId(0), [{ fileId: upload.id, role: 'reference' }]);

    const lineage = await buildFileLineage(root, depsFor([root, upload]));

    expect(lineage.ancestors[1]).toMatchObject({ generator: null, modelId: null, request: null, prompt: null });
  });

  it('keeps children in the id query order and drops unreadable ones', async () => {
    const [root, newer, hidden, older] = [0, 1, 2, 3].map(hexId);
    const files = [
      makeFile(root),
      makeFile(older, [{ fileId: root, role: 'reference' }]),
      makeFile(newer, [{ fileId: root, role: 'variation_of' }]),
      makeFile(hidden, [{ fileId: root, role: 'style' }]),
    ];

    const lineage = await buildFileLineage(
      files[0],
      depsFor(files, { hidden: [hidden], children: [newer, hidden, older] })
    );

    expect(lineage.children.map(node => node.fileId)).toEqual([newer, older]);
    expect(lineage.edges).toEqual([
      { parentId: root, childId: newer, role: 'variation_of' },
      { parentId: root, childId: older, role: 'reference' },
    ]);
  });

  it('scans past a page of unreadable newer children to find the readable ones', async () => {
    const root = makeFile(hexId(0));
    const unreadable = Array.from({ length: 60 }, (_, n) =>
      makeFile(hexId(n + 1), [{ fileId: root.id, role: 'reference' }])
    );
    const mine = makeFile(hexId(100), [{ fileId: root.id, role: 'variation_of' }]);
    const ordered = [...unreadable, mine].map(file => file.id);
    const deps = depsFor([root, ...unreadable, mine], { hidden: unreadable.map(file => file.id) });
    deps.findChildIds.mockImplementation(async (_id: string, { limit, skip }: { limit: number; skip: number }) =>
      ordered.slice(skip, skip + limit)
    );

    const lineage = await buildFileLineage(root, deps);

    expect(lineage.children.map(node => node.fileId)).toEqual([mine.id]);
    expect(deps.findChildIds).toHaveBeenCalledTimes(2);
  });

  it('ignores a self-reference and repeated entries', async () => {
    const [root, parent] = [0, 1].map(hexId);
    const files = [
      makeFile(root, [
        { fileId: root, role: 'reference' },
        { fileId: parent.toUpperCase(), role: 'style' },
        { fileId: parent, role: 'style' },
      ]),
      makeFile(parent),
    ];

    const lineage = await buildFileLineage(files[0], depsFor(files, { children: [root] }));

    expect(lineage.ancestors.map(node => node.fileId)).toEqual([root, parent]);
    expect(lineage.ancestors[1].redacted).toBe(false);
    expect(lineage.edges).toEqual([{ parentId: parent, childId: root, role: 'style' }]);
    expect(lineage.children).toEqual([]);
  });
});
