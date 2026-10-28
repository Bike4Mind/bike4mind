type RequestUser = { id: string };

/** The ids a bulk action must never touch for this request: the admin, and under impersonation both accounts. */
export function selfIdsOf(user: RequestUser): string[] {
  // Declared locally: the `impersonatedBy` augmentation lives in apps/client/global.d.ts.
  const { impersonatedBy } = user as RequestUser & { impersonatedBy?: string };
  return impersonatedBy ? [user.id, impersonatedBy] : [user.id];
}
