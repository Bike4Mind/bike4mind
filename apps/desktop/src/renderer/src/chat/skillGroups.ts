import type { SkillSummary } from '@shared/skills';

/** Above this many groups the Skills tab opens collapsed, so it reads as an index, not a wall. */
export const COLLAPSE_ABOVE_GROUPS = 10;

export interface SkillGroupModel {
  key: string;
  title: string;
  skills: SkillSummary[];
}

export function skillMatchesQuery(skill: SkillSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [skill.name, skill.displayName, skill.description].some(field => field?.toLowerCase().includes(needle));
}

/** Each group cut to its matching skills; groups left empty are dropped. */
export function filterSkillGroups(groups: SkillGroupModel[], query: string): SkillGroupModel[] {
  if (!query.trim()) return groups;
  return groups
    .map(group => ({ ...group, skills: group.skills.filter(skill => skillMatchesQuery(skill, query)) }))
    .filter(group => group.skills.length > 0);
}

/**
 * What the user expanded or collapsed, kept in renderer memory so reopening Customize keeps it and
 * an app restart forgets it. `all` is the last Collapse/Expand all; `groups` overrides it per group.
 */
const remembered: { all: boolean | null; groups: Map<string, boolean> } = { all: null, groups: new Map() };

export function rememberedExpansion(key: string, fallback: boolean): boolean {
  return remembered.groups.get(key) ?? remembered.all ?? fallback;
}

export function rememberGroupExpansion(key: string, expanded: boolean): void {
  remembered.groups.set(key, expanded);
}

export function rememberAllExpansion(expanded: boolean): void {
  remembered.all = expanded;
  remembered.groups.clear();
}

export function forgetSkillGroupExpansion(): void {
  remembered.all = null;
  remembered.groups.clear();
}
