export type Epithet = 'Warden' | 'Scribe' | 'Tinkerer' | 'Cartographer' | 'Seeker' | 'Wanderer';

/** What a persona is derived from: an agent's id, creation time, title and seed prompt. */
export type PersonaSubject = { id: string; createdAt: string; title: string; seedPrompt: string };

export type AgentPersona = { name: string; epithet: Epithet; label: string; shortTitle: string };

const SEPARATORS = [':', ' - ', ' | '] as const;

/** Every prefix of `title` that ends right after a separator. */
function separatorPrefixes(title: string): string[] {
  return SEPARATORS.flatMap(separator => {
    const prefixes: string[] = [];
    for (let at = title.indexOf(separator); at !== -1; at = title.indexOf(separator, at + 1)) {
      prefixes.push(title.slice(0, at + separator.length));
    }
    return prefixes;
  });
}

/**
 * Strips the longest separator-terminated prefix that at least one other title shares, so siblings such as
 * "Desktop audit: unused files" and "Desktop audit: large files" tell apart. Never returns an empty string.
 */
export function distinctTitle(title: string, siblingTitles: readonly string[]): string {
  // `siblingTitles` normally includes this title; count it once whether or not it does.
  const others = [...siblingTitles];
  const own = others.indexOf(title);
  if (own !== -1) others.splice(own, 1);

  const shared = separatorPrefixes(title)
    .filter(prefix => others.some(other => other.startsWith(prefix)))
    .sort((a, b) => b.length - a.length)[0];
  if (!shared) return title;
  const rest = title.slice(shared.length).trim();
  return rest === '' ? title : rest;
}

export const PERSONA_NAMES: readonly string[] = [
  'Brannoc',
  'Elowen',
  'Thistle',
  'Grimble',
  'Maelis',
  'Dorrin',
  'Wren',
  'Halvard',
  'Fennick',
  'Isolde',
  'Torvin',
  'Marigold',
  'Bramwell',
  'Sorrel',
  'Kestrel',
  'Orwin',
  'Pippa',
  'Garrick',
  'Linnet',
  'Rhosyn',
  'Tamsin',
  'Ulric',
  'Veyra',
  'Wulfric',
  'Yarrow',
  'Zephra',
  'Aldwin',
  'Bryony',
  'Corwen',
  'Darya',
  'Eadric',
  'Fiora',
  'Gunnar',
  'Hazel',
  'Ingvar',
  'Jorun',
  'Kelda',
  'Lorcan',
  'Mirren',
  'Nettle',
  'Osric',
  'Perrin',
  'Quillon',
  'Rowan',
  'Sigrun',
  'Tobiah',
  'Ysolde',
  'Brindle',
];

// First match wins, so order is precedence: a "review the tests" task is a Warden's.
const EPITHET_RULES: ReadonlyArray<readonly [Epithet, readonly string[]]> = [
  ['Warden', ['review', 'security', 'vulnerab', 'permission']],
  ['Scribe', ['doc', 'readme', 'changelog', 'summar', 'report', 'write-up', 'jsdoc', 'comment']],
  ['Tinkerer', ['test', 'fix', 'implement', 'refactor', 'build', 'add ', 'migrate', 'bug']],
  ['Cartographer', ['map', 'list', 'largest', 'structure', 'architect', 'inventory', 'size']],
  ['Seeker', ['find', 'search', 'audit', 'scan', 'investigate', 'look for', 'unused', 'todo']],
];

export function epithetFor(title: string, seedPrompt: string): Epithet {
  const text = `${title}\n${seedPrompt}`.toLowerCase();
  const rule = EPITHET_RULES.find(([, keywords]) => keywords.some(keyword => text.includes(keyword)));
  return rule ? rule[0] : 'Wanderer';
}

function hashOf(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return hash;
}

const byAge = (a: PersonaSubject, b: PersonaSubject) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * A pure function of ids, creation times, titles and prompts, so a persona survives restarts. Agents claim
 * names oldest first, which keeps existing agents' names when a newer one joins.
 */
export function assignPersonas(agents: readonly PersonaSubject[]): Map<string, AgentPersona> {
  const titles = agents.map(agent => agent.title);
  const taken = new Set<number>();
  const personas = new Map<string, AgentPersona>();
  for (const agent of [...agents].sort(byAge)) {
    let index = hashOf(agent.id) % PERSONA_NAMES.length;
    // Past 48 agents names must repeat; the probe then stops instead of looping forever.
    for (let probes = 0; taken.has(index) && probes < PERSONA_NAMES.length; probes++) {
      index = (index + 1) % PERSONA_NAMES.length;
    }
    taken.add(index);
    const name = PERSONA_NAMES[index] ?? 'Wren';
    const epithet = epithetFor(agent.title, agent.seedPrompt);
    personas.set(agent.id, {
      name,
      epithet,
      label: `${name} the ${epithet}`,
      shortTitle: distinctTitle(agent.title, titles),
    });
  }
  return personas;
}
