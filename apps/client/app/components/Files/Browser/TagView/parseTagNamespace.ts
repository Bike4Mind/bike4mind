export interface TagNode {
  segment: string;
  fullPath: string;
  /** This node's own count plus every descendant's - what the folder row's chip shows. */
  fileCount: number;
  /**
   * Files tagged with this node's exact fullPath, as opposed to a deeper child tag. A node can
   * carry both children AND its own directly-tagged files (e.g. a file tagged "a:b" while
   * others are tagged "a:b:c") - those own-tagged files are otherwise unreachable from the tree,
   * since navigating into a branch node only ever shows its children (#1692).
   */
  ownFileCount: number;
  children: TagNode[];
}

/**
 * Builds a hierarchical tree from flat colon-separated tag strings.
 *
 * Input:  [{ tag: "opti:family:scheduling", count: 12 }, { tag: "opti:family:budgeting", count: 8 }]
 * Output: tree of TagNodes grouped by colon-separated segments
 */
export function buildTagTree(tagCounts: { tag: string; count: number }[]): TagNode[] {
  const rootChildren: TagNode[] = [];

  for (const { tag, count } of tagCounts) {
    const segments = tag.split(':');
    let currentLevel = rootChildren;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const fullPath = segments.slice(0, i + 1).join(':');
      const isLeaf = i === segments.length - 1;

      let existing = currentLevel.find(n => n.segment === segment);
      if (!existing) {
        existing = { segment, fullPath, fileCount: 0, ownFileCount: 0, children: [] };
        currentLevel.push(existing);
      }

      if (isLeaf) {
        existing.ownFileCount += count;
      }

      currentLevel = existing.children;
    }
  }

  // fileCount = this node's own count plus every descendant's, computed bottom-up.
  function sumCounts(nodes: TagNode[]): number {
    for (const node of nodes) {
      const childSum = node.children.length > 0 ? sumCounts(node.children) : 0;
      node.fileCount = node.ownFileCount + childSum;
    }
    return nodes.reduce((sum, n) => sum + n.fileCount, 0);
  }
  sumCounts(rootChildren);

  // Sort alphabetically within each level
  function sortLevel(nodes: TagNode[]) {
    nodes.sort((a, b) => a.segment.localeCompare(b.segment));
    for (const node of nodes) {
      sortLevel(node.children);
    }
  }
  sortLevel(rootChildren);

  return rootChildren;
}

/**
 * Navigate to a specific depth in the tag tree given a breadcrumb path.
 * Returns the children at that depth.
 */
export function getNodesAtPath(roots: TagNode[], breadcrumb: string[]): TagNode[] {
  let current = roots;
  for (const segment of breadcrumb) {
    const found = current.find(n => n.segment === segment);
    if (!found) return [];
    current = found.children;
  }
  return current;
}

/**
 * The node AT a breadcrumb path, as opposed to getNodesAtPath's children of it. Null for the
 * root (breadcrumb [], which has no single node) or a path that doesn't exist in the tree.
 */
export function getNodeAtPath(roots: TagNode[], breadcrumb: string[]): TagNode | null {
  let current = roots;
  let node: TagNode | null = null;
  for (const segment of breadcrumb) {
    const found = current.find(n => n.segment === segment);
    if (!found) return null;
    node = found;
    current = found.children;
  }
  return node;
}
