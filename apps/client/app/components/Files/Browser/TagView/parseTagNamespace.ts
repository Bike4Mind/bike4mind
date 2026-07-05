export interface TagNode {
  segment: string;
  fullPath: string;
  fileCount: number;
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
        existing = { segment, fullPath, fileCount: 0, children: [] };
        currentLevel.push(existing);
      }

      if (isLeaf) {
        existing.fileCount += count;
      }

      currentLevel = existing.children;
    }
  }

  // Propagate counts upward: each node's fileCount = sum of all descendant leaf counts
  function sumCounts(nodes: TagNode[]): number {
    for (const node of nodes) {
      if (node.children.length > 0) {
        const childSum = sumCounts(node.children);
        node.fileCount += childSum;
      }
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
