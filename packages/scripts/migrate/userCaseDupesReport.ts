export type UserIdentityRow = {
  id: string;
  createdAt: Date | null;
  emailVerified: boolean | null;
  value: unknown;
};

export type CaseDupeMember = Omit<UserIdentityRow, 'value'>;

/**
 * Group rows whose string value collides once trimmed and lowercased, keeping only groups with
 * more than one member. Non-string and empty values are skipped. The normalized key is not
 * returned, so a report built from this never prints the addresses or names themselves.
 */
export function findCaseInsensitiveCollisions(rows: Iterable<UserIdentityRow>): CaseDupeMember[][] {
  const groups = new Map<string, CaseDupeMember[]>();
  for (const { value, ...member } of rows) {
    if (typeof value !== 'string') continue;
    const key = value.trim().toLowerCase();
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(member);
    else groups.set(key, [member]);
  }
  return [...groups.values()].filter(group => group.length > 1).sort((a, b) => b.length - a.length);
}

export function renderCollisionGroups(label: string, groups: CaseDupeMember[][]): string[] {
  if (groups.length === 0) return [`No case-insensitive ${label} collisions.`];
  const lines = [`Found ${groups.length} case-insensitive ${label} collision group(s):`];
  groups.forEach((group, index) => {
    lines.push(`  group ${index + 1}: n=${group.length}`);
    for (const member of group) {
      lines.push(
        `    id=${member.id} createdAt=${member.createdAt?.toISOString() ?? '<none>'} emailVerified=${member.emailVerified ?? '<none>'}`
      );
    }
  });
  return lines;
}
