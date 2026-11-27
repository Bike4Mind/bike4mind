import { toCsv } from './csv';

/** The migrate API returns only name and email per created user (no password), so the CSV has two columns. */
export function buildMigratedUsersCsv(users: Array<{ name: string; email: string }>): string {
  return toCsv([['Name', 'Email'], ...users.map(user => [user.name, user.email])]);
}
