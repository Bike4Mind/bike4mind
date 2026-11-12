import {
  GeneratedAssetMetadataSchema,
  type GeneratedAssetGenerator,
  type GeneratedAssetLineageEntry,
  type GeneratedAssetLineageRole,
  type IFabFileDocument,
} from '@bike4mind/common';

/** Ancestor generations walked above the root. Each level costs one batched access-checked read. */
export const LINEAGE_MAX_DEPTH = 8;
/** Ancestor nodes returned, the root included. Bounds payload and DB work for wide, multi-input trails. */
export const LINEAGE_MAX_NODES = 32;
/** Direct children returned, newest first. */
export const LINEAGE_MAX_CHILDREN = 24;
/**
 * Child ids scanned per page, and the pages scanned at most. The id query is not access-scoped, so a popular source
 * can have many newer children the caller cannot read; scanning a few pages keeps theirs from being crowded out.
 */
const CHILD_SCAN_PAGE_SIZE = 48;
const CHILD_SCAN_MAX_PAGES = 4;

type LineageNodeBase = {
  fileId: string;
  /** 0 for the root, n for an n-th generation ancestor, -1 for a direct child. */
  depth: number;
};

/** An ancestor the caller cannot read: only its id and position, never its metadata or its own ancestors. */
export type RedactedLineageNode = LineageNodeBase & { redacted: true };

export type VisibleLineageNode = LineageNodeBase & {
  redacted: false;
  fileName: string;
  mimeType: string;
  /** Null for a file that was not generated (an upload used as a reference, say). */
  generator: GeneratedAssetGenerator | null;
  modelId: string | null;
  prompt: string | null;
  /** The signed, browser-facing URL; null when moderation withholds it. */
  url: string | null;
  createdAt: string;
  /** The stored generation request (`sourceMetadata.generation.request`), for "restore these settings". */
  request: Record<string, unknown> | null;
};

export type LineageNode = RedactedLineageNode | VisibleLineageNode;

/** One `derivedFrom` entry: `childId` was made from `parentId` in `role`. */
export type LineageEdge = { parentId: string; childId: string; role: GeneratedAssetLineageRole };

export type FileLineage = {
  fileId: string;
  /** The root first, then ancestors by ascending depth. */
  ancestors: LineageNode[];
  /** Readable files made from the root, newest first. */
  children: VisibleLineageNode[];
  edges: LineageEdge[];
  /** True when the depth or node cap cut the ancestor walk short. */
  truncated: boolean;
};

export type FileLineageDeps = {
  /** The files among `ids` the caller may read, signed; unreadable or missing ids are absent. */
  readAccessible: (ids: string[]) => Promise<IFabFileDocument[]>;
  /** Ids of live generated files whose `derivedFrom` names `fileId`, newest first. */
  findChildIds: (fileId: string, page: { limit: number; skip: number }) => Promise<string[]>;
};

const toIsoString = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : new Date(0).toISOString();
};

function toVisibleNode(file: IFabFileDocument, depth: number): VisibleLineageNode {
  const generation = GeneratedAssetMetadataSchema.safeParse(file.sourceMetadata?.generation);
  const metadata = generation.success ? generation.data : null;
  return {
    fileId: file.id,
    depth,
    redacted: false,
    fileName: file.fileName,
    mimeType: file.mimeType,
    generator: metadata?.generator ?? null,
    modelId: metadata?.modelId ?? null,
    prompt: metadata?.prompt ?? null,
    url: file.fileUrl || file.presignedUrl || null,
    createdAt: toIsoString(file.createdAt),
    request: metadata?.request ?? null,
  };
}

/**
 * A file's lineage entries with ids lowercased (the file ids they are matched against are) and any entry naming
 * the file itself dropped, so a malformed self-reference cannot become a self-edge.
 */
const lineageOf = (file: IFabFileDocument): GeneratedAssetLineageEntry[] =>
  (file.derivedFrom ?? [])
    .map(entry => ({ ...entry, fileId: entry.fileId.toLowerCase() }))
    .filter(entry => entry.fileId !== file.id);

const edgeKey = (edge: LineageEdge) => `${edge.parentId}:${edge.childId}:${edge.role}`;

/** Drops repeats: a file may list the same parent in the same role twice. */
const uniqueEdges = (edges: LineageEdge[]) => [...new Map(edges.map(edge => [edgeKey(edge), edge])).values()];

/**
 * The ancestry of `root` (already access-checked by the caller) walked breadth-first through `derivedFrom`,
 * plus its direct children. Bounded by LINEAGE_MAX_DEPTH and LINEAGE_MAX_NODES, and cycle-safe. An ancestor
 * the caller cannot read comes back redacted and the walk stops there, so its own inputs never leak.
 */
export async function buildFileLineage(root: IFabFileDocument, deps: FileLineageDeps): Promise<FileLineage> {
  const ancestors: LineageNode[] = [toVisibleNode(root, 0)];
  const seen = new Set<string>([root.id]);
  const edges: LineageEdge[] = [];
  let frontier: IFabFileDocument[] = [root];
  let truncated = false;

  for (let depth = 1; frontier.length > 0; depth++) {
    const parentIds = [...new Set(frontier.flatMap(file => lineageOf(file).map(entry => entry.fileId)))].filter(
      id => !seen.has(id)
    );
    const room = depth > LINEAGE_MAX_DEPTH ? 0 : Math.max(0, LINEAGE_MAX_NODES - ancestors.length);
    const levelIds = parentIds.slice(0, room);
    if (levelIds.length < parentIds.length) truncated = true;
    levelIds.forEach(id => seen.add(id));

    // Edges to a parent already on the trail (a diamond) are kept; edges past a cap are dropped with it.
    for (const file of frontier) {
      for (const entry of lineageOf(file)) {
        if (seen.has(entry.fileId)) edges.push({ parentId: entry.fileId, childId: file.id, role: entry.role });
      }
    }
    if (levelIds.length === 0) break;

    const readableById = new Map((await deps.readAccessible(levelIds)).map(file => [file.id, file]));
    for (const id of levelIds) {
      const file = readableById.get(id);
      ancestors.push(file ? toVisibleNode(file, depth) : { fileId: id, depth, redacted: true });
    }
    frontier = levelIds.flatMap(id => readableById.get(id) ?? []);
  }

  const children = await readChildren(root.id, deps);
  for (const child of children.files) {
    for (const entry of lineageOf(child)) {
      if (entry.fileId === root.id) edges.push({ parentId: root.id, childId: child.id, role: entry.role });
    }
  }

  return { fileId: root.id, ancestors, children: children.nodes, edges: uniqueEdges(edges), truncated };
}

/** Up to LINEAGE_MAX_CHILDREN readable children, newest first, scanning a bounded number of id pages. */
async function readChildren(rootId: string, deps: FileLineageDeps) {
  const files: IFabFileDocument[] = [];
  const scanned = new Set<string>();
  for (let page = 0; page < CHILD_SCAN_MAX_PAGES && files.length < LINEAGE_MAX_CHILDREN; page++) {
    const pageIds = await deps.findChildIds(rootId, { limit: CHILD_SCAN_PAGE_SIZE, skip: page * CHILD_SCAN_PAGE_SIZE });
    // Skip-paging shifts when a child is created between pages, so the next page can repeat an id.
    const childIds = pageIds.filter(id => id !== rootId && !scanned.has(id));
    childIds.forEach(id => scanned.add(id));
    if (childIds.length > 0) {
      const readableById = new Map((await deps.readAccessible(childIds)).map(file => [file.id, file]));
      // Keep the newest-first order of the id query; the access read does not preserve it.
      files.push(...childIds.flatMap(id => readableById.get(id) ?? []));
    }
    if (pageIds.length < CHILD_SCAN_PAGE_SIZE) break;
  }
  const kept = files.slice(0, LINEAGE_MAX_CHILDREN);
  return { files: kept, nodes: kept.map(file => toVisibleNode(file, -1)) };
}
