export const CORE = ['unauthenticated', 'notebook', 'prompts'];
export const EXCLUDED = ['launch-readiness', 'referrals'];
export const SUITES = [
  ...CORE, ...EXCLUDED, 'radio-hit-target', 'static-asset', 'websocket-auth', 'admin',
  'notebook-files', 'projects', 'agents', 'image-gen', 'profile', 'tavern', 'search',
  'data-lake', 'skills', 'teams', 'studio', 'credits', 'notebook-export-bytes',
  'ai-latency-short-answers', 'ai-latency-long-answers', 'ai-latency-tool-prompts',
  'ai-latency-intermediate-tools', 'ai-latency-discover', 'tutorial-basics',
];
export const STANDALONE = [
  'selfhost-chat-stream.spec.ts', 'selfhost-pod-roll.spec.ts',
  'selfhost-upload-readable.spec.ts', 'selfhost-upload-readable.selftest.spec.ts',
];

// Only reviewed, feature-local components narrow coverage. All other paths widen it.
export const PATH_PROJECTS = [
  ['apps/client/app/components/Project/', ['projects']],
  ['apps/client/app/components/Agent/', ['agents']],
  ['apps/client/app/components/AgentList/', ['agents']],
  ['apps/client/app/components/ImageStudio/', ['image-gen', 'studio']],
  ['apps/client/app/components/ProfileModal/', ['profile']],
  ['apps/client/app/components/profile/', ['profile']],
  ['apps/client/app/components/datalake/', ['data-lake']],
  ['apps/client/app/components/DataLakeWizard/', ['data-lake']],
  ['apps/client/app/components/SkillsManagement/', ['skills']],
  ['apps/client/app/components/SkillMarket/', ['skills']],
  ['apps/client/app/components/Studio/', ['studio']],
  ['apps/client/app/components/tavern/', ['tavern']],
  ['apps/client/app/components/Credits/', ['credits']],
  ['apps/client/app/components/admin/', ['admin']],
];

const isDependency = name => name === 'setup-core' || name === 'warmup' ||
  (name.startsWith('setup-') && SUITES.includes(name.slice(6)));

function matches(project, file) {
  if (project.testDir || project.testIgnore || project.grep || project.grepInvert) {
    throw new Error(`Unresolvable project filtering for ${project.name}`);
  }
  const patterns = Array.isArray(project.testMatch) ? project.testMatch : [project.testMatch];
  if (!patterns.length || patterns.some(pattern => !(pattern instanceof RegExp))) {
    throw new Error(`Unresolvable testMatch for ${project.name}`);
  }
  return patterns.some(pattern => new RegExp(pattern.source, pattern.flags).test(file));
}

export function dependencyClosure(projects, names) {
  const byName = new Map(projects.map(project => [project.name, project]));
  const seen = new Set();
  const visiting = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new Error(`Dependency cycle: ${name}`);
    if (seen.has(name)) return;
    const project = byName.get(name);
    if (!project) throw new Error(`Missing dependency: ${name}`);
    visiting.add(name);
    for (const dependency of project.dependencies ?? []) visit(dependency);
    visiting.delete(name);
    seen.add(name);
  }
  names.forEach(visit);
  return [...seen];
}

export function prEligibleConfigProjects(projects) {
  return projects.filter(project => {
    if (EXCLUDED.includes(project.name)) return false;
    try {
      return !dependencyClosure(projects, [project.name]).some(name => EXCLUDED.includes(name));
    } catch {
      // Broken graphs must not turn into a green empty run; let Playwright reject them.
      return true;
    }
  });
}

export function eligibleProjects(projects) {
  return prEligibleConfigProjects(projects).filter(project => !isDependency(project.name))
    .map(project => project.name).sort();
}

export function classificationErrors(projects, files) {
  const errors = [];
  const names = projects.map(project => project.name);
  if (new Set(names).size !== names.length) errors.push('Duplicate project names');
  for (const project of projects) {
    if (!SUITES.includes(project.name) && !isDependency(project.name)) {
      errors.push(`Unclassified project: ${project.name}`);
    }
    try {
      dependencyClosure(projects, [project.name]);
      if (!files.some(file => matches(project, file))) errors.push(`Empty project: ${project.name}`);
    } catch (error) { errors.push(error.message); }
  }
  for (const file of files) {
    try {
      if (!projects.some(project => matches(project, file))) errors.push(`Uncovered spec: ${file}`);
    } catch (error) { errors.push(error.message); }
  }
  return [...new Set(errors)];
}

export function selectProjects({ projects, files, changedPaths, full = false, errors = /** @type {string[]} */ ([]) }) {
  const all = eligibleProjects(projects);
  const fallback = reason => ({ projects: all, mode: 'full', reason });
  if (full) return fallback('e2e:full');
  if (errors.length) return fallback(errors.join('; '));
  const guard = classificationErrors(projects, files);
  if (guard.length) return fallback(guard.join('; '));
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return fallback('Missing diff');
  const selected = new Set(CORE);
  for (const file of changedPaths) {
    if (typeof file !== 'string' || file.includes('..') || file.includes('\\')) return fallback('Invalid path');
    if (/^apps\/client\/e2e\/[^/]+\.spec\.tsx?$/.test(file)) {
      const owners = projects.filter(project => matches(project, file));
      if (!owners.length) return fallback(`Unmapped spec: ${file}`);
      owners.forEach(project => selected.add(project.name));
      continue;
    }
    const rules = PATH_PROJECTS.filter(([prefix]) => file.startsWith(prefix));
    if (!rules.length) return fallback(`Shared or unmapped path: ${file}`);
    rules.flatMap(([, names]) => names).forEach(name => selected.add(name));
  }
  if ([...selected].some(name => !all.includes(name) && !EXCLUDED.includes(name))) {
    return fallback('Selected project unavailable');
  }
  return { projects: [...selected].filter(name => all.includes(name)).sort(), mode: 'selected', reason: 'Reviewed path mapping' };
}
