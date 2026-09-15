// Deterministic color assignment for tag chips
// Each tag always gets the same color via a simple hash function

const TAG_PALETTE = [
  '#1976d2', // blue
  '#7b1fa2', // purple
  '#2e7d32', // green
  '#f57c00', // orange
  '#00838f', // teal
  '#c2185b', // pink
  '#5d4037', // brown
  '#455a64', // blue-grey
  '#d32f2f', // red
  '#0097a7', // cyan
  '#689f38', // light green
  '#fbc02d', // yellow
];

// Predefined tags get fixed colors for consistency
const FIXED_COLORS: Record<string, string> = {
  Developer: '#1976d2',
  Analyst: '#7b1fa2',
  Customer: '#2e7d32',
  Admin: '#d32f2f',
  PI: '#f57c00',
  QuestMaster: '#c2185b',
  Agents: '#455a64',
};

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

export function getTagColor(tag: string): string {
  if (FIXED_COLORS[tag]) return FIXED_COLORS[tag];
  return TAG_PALETTE[hashString(tag) % TAG_PALETTE.length];
}
