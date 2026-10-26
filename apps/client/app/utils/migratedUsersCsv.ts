import { escapeCsvCell, quoteCsvCellVerbatim } from './csv';

interface MigratedUser {
  name: string;
  email: string;
  tempPassword?: string;
}

/** Name and email are formula-escaped; the password is quoted verbatim so it can be copied exactly. */
export function buildMigratedUsersCsv(users: MigratedUser[]): string {
  const withPassword = Boolean(users[0]?.tempPassword);
  const header = ['Name', 'Email', ...(withPassword ? ['Temporary Password'] : [])].map(escapeCsvCell);
  const rows = users.map(user => {
    const cells = [escapeCsvCell(user.name), escapeCsvCell(user.email)];
    if (withPassword) cells.push(quoteCsvCellVerbatim(user.tempPassword ?? ''));
    return cells;
  });
  return [header, ...rows].map(row => row.join(',')).join('\n');
}
