export const MIRROR_DATABASE_ROLES = ['MONGODB_APP_URI', 'MONGODB_WORKER_URI', 'MONGODB_MIGRATION_URI'] as const;

export function mirrorReadinessFailures(
  read: (name: string) => string | undefined,
  boundary: { runtimeUsesDedicatedRoles: boolean; includedWritersInstrumented: boolean }
): string[] {
  const failures: string[] = [];
  const legacy = read('MONGODB_URI');
  const values = MIRROR_DATABASE_ROLES.map(name => {
    const value = read(name);
    if (
      !value ||
      value === 'not-configured' ||
      value === 'my-secret-placeholder-value' ||
      !/^mongodb(\+srv)?:\/\//.test(value)
    )
      failures.push(`${name} is not configured`);
    if (value && value === legacy) failures.push(`${name} shares the legacy credential`);
    return value;
  });
  if (new Set(values).size !== values.length) failures.push('Database roles are not distinct');
  if (!boundary.runtimeUsesDedicatedRoles) failures.push('Runtime still has access to the shared database credential');
  if (!boundary.includedWritersInstrumented) failures.push('Included writers are not instrumented');
  return failures;
}
