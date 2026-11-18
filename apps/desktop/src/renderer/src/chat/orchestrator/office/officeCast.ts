export const OFFICE_PARENT = 'Michael Scott';

export const OFFICE_CAST = [
  'Jim Halpert',
  'Dwight Schrute',
  'Pam Beesly',
  'Stanley Hudson',
  'Phyllis Vance',
  'Angela Martin',
  'Oscar Martinez',
  'Kevin Malone',
  'Meredith Palmer',
  'Creed Bratton',
  'Ryan Howard',
  'Kelly Kapoor',
  'Toby Flenderson',
  'Andy Bernard',
  'Darryl Philbin',
  'Erin Hannon',
] as const;

export type OfficeCharacter = (typeof OFFICE_CAST)[number];

type CastSubject = { id: string; createdAt: string };

export function assignOfficeCast(agents: readonly CastSubject[]): ReadonlyMap<string, OfficeCharacter> {
  const ordered = [...agents].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
  return new Map(ordered.map((agent, index) => [agent.id, OFFICE_CAST[index % OFFICE_CAST.length]]));
}
