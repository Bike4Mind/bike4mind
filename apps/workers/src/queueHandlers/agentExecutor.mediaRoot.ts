type MediaExecution = {
  id: string;
  userId: string;
  sessionId: string;
  organizationId?: string;
  parentExecutionId?: string;
  spawnedByExecutionId?: string;
};

export async function resolveMediaRoot<T extends MediaExecution>(
  child: T,
  findById: (id: string) => Promise<T | null | undefined>
): Promise<T | undefined> {
  const visited = new Set<string>();
  let current = child;
  while (!visited.has(current.id)) {
    visited.add(current.id);
    const parentId = current.parentExecutionId ?? current.spawnedByExecutionId;
    if (!parentId) return current;
    const parent = await findById(parentId);
    if (
      !parent ||
      parent.userId !== child.userId ||
      parent.sessionId !== child.sessionId ||
      parent.organizationId !== child.organizationId
    )
      return undefined;
    current = parent;
  }
  return undefined;
}
