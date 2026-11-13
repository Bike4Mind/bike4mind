export function readTeamPreference(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function writeTeamPreference(key: string, value: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private browsing; navigation must still work.
  }
}

export const recentTeamsKey = (userId: string) => `team-recents:${userId}`;

export function rememberTeam(userId: string, teamId: string): void {
  const key = recentTeamsKey(userId);
  writeTeamPreference(key, [teamId, ...readTeamPreference(key).filter(id => id !== teamId)].slice(0, 10));
}
