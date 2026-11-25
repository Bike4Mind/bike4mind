export const OFFICE_PARENT = 'Manager';

// Index order matters: OfficeSprite picks each look (glasses, tie, hair) by position in this list.
export const OFFICE_CAST = [
  'Lim Dalpert',
  'Bright Fute',
  'Bam Teesly',
  'Barryl Gilbin',
  'Lillis Dance',
  'Bangela Partin',
  'Danley Mudson',
  'Bevin Balone',
  'Bredith Calmer',
  'Freed Gratton',
  'Fryan Soward',
  'Nelly Tapoor',
  'Candy Fernard',
  'Moby Blenderson',
  'Boscar Partinez',
  'Karin Shannon',
] as const;

export type OfficeCharacter = (typeof OFFICE_CAST)[number];

type CastSubject = { id: string; createdAt: string };

export function assignOfficeCast(agents: readonly CastSubject[]): ReadonlyMap<string, OfficeCharacter> {
  const ordered = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return new Map(ordered.map((agent, index) => [agent.id, OFFICE_CAST[index % OFFICE_CAST.length]]));
}
