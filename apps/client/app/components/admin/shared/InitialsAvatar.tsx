import { Avatar } from '@mui/joy';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

const TONES: readonly AdminStatusTone[] = ['info', 'good', 'warn', 'neutral', 'bad'];

/** Up to two initials from a name, else the first character of the fallback (e.g. an email). */
export function initialsOf(name: string | undefined, fallback: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return (fallback.trim()[0] ?? '?').toUpperCase();
  return words
    .slice(0, 2)
    .map(word => word[0])
    .join('')
    .toUpperCase();
}

/** A stable tone per seed, so a person keeps their color across pages. */
function toneOf(seed: string): AdminStatusTone {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return TONES[Math.abs(hash) % TONES.length];
}

/** A 32 px avatar: the photo when there is one, else initials on a status-tone fill. */
export function InitialsAvatar({
  name,
  fallback,
  seed,
  src,
}: {
  name?: string;
  fallback: string;
  seed: string;
  src?: string;
}) {
  const tone = toneOf(seed);
  return (
    <Avatar
      src={src || undefined}
      alt=""
      sx={theme => ({
        width: 32,
        height: 32,
        fontSize: 12,
        fontWeight: 600,
        flexShrink: 0,
        color: theme.vars.palette.admin.status[tone].foreground,
        bgcolor: theme.vars.palette.admin.status[tone].background,
      })}
    >
      {initialsOf(name, fallback)}
    </Avatar>
  );
}
