export const OFFICE_PARENT = 'Morgan Reed';

export const OFFICE_CAST = [
  'Elliot Vale',
  'Felix Rowan',
  'Nora Finch',
  'Amos Bell',
  'Clara Wren',
  'Iris Lane',
  'Ravi Mehta',
  'Hugo Moss',
  'Hazel Pike',
  'Otis Grey',
  'Leo Mercer',
  'Mina Park',
  'Quinn Foster',
  'Theo Birch',
  'Dorian Wells',
  'Willa Hart',
] as const;

export type OfficeCharacter = (typeof OFFICE_CAST)[number];

type CastSubject = { id: string; createdAt: string };

export function assignOfficeCast(agents: readonly CastSubject[]): ReadonlyMap<string, OfficeCharacter> {
  const ordered = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return new Map(ordered.map((agent, index) => [agent.id, OFFICE_CAST[index % OFFICE_CAST.length]]));
}
