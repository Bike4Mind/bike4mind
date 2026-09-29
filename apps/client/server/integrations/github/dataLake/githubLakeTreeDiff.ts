import type { GitHubLakeCandidate } from './lakeFileFilter';

export type GitHubLakeStoredCopy = {
  id: string;
  createdAt: Date | string;
  githubPath?: string;
  githubBlobSha?: string;
};

export type GitHubLakeTreeDiff<T extends GitHubLakeStoredCopy> = {
  adds: GitHubLakeCandidate[];
  changed: { candidate: GitHubLakeCandidate; prior: T }[];
  removed: T[];
  duplicates: { keep: T; retire: T[] }[];
};

export function diffGitHubLakeTree<T extends GitHubLakeStoredCopy>(
  candidates: readonly GitHubLakeCandidate[],
  stored: readonly T[]
): GitHubLakeTreeDiff<T> {
  const copiesByPath = new Map<string, T[]>();
  for (const copy of stored) {
    if (!copy.githubPath) continue;
    const copies = copiesByPath.get(copy.githubPath);
    if (copies) copies.push(copy);
    else copiesByPath.set(copy.githubPath, [copy]);
  }
  // Newest first: the head is what the last ingest wrote and anchors change detection; the tail is duplicates.
  for (const copies of copiesByPath.values()) {
    copies.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  const diff: GitHubLakeTreeDiff<T> = { adds: [], changed: [], removed: [], duplicates: [] };
  const inTree = new Set<string>();
  for (const candidate of candidates) {
    inTree.add(candidate.path);
    const copies = copiesByPath.get(candidate.path);
    if (!copies) {
      diff.adds.push(candidate);
      continue;
    }
    if (copies[0].githubBlobSha !== candidate.sha) diff.changed.push({ candidate, prior: copies[0] });
    if (copies.length > 1) diff.duplicates.push({ keep: copies[0], retire: copies.slice(1) });
  }
  for (const [githubPath, copies] of copiesByPath) {
    if (!inTree.has(githubPath)) diff.removed.push(...copies);
  }
  return diff;
}
