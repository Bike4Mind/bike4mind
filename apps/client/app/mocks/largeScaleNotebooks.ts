import { ISessionDocument } from '@bike4mind/common';

interface SessionTag {
  name: string;
  strength: number;
}

// Realistic notebook name components
const NOTEBOOK_PREFIXES = [
  'Meeting Notes',
  'Project',
  'Research',
  'Daily Standup',
  'Sprint Planning',
  'Code Review',
  'Design Review',
  'Customer Call',
  'Interview',
  'Brainstorm',
  'Strategy Session',
  'Retrospective',
  'Architecture',
  'Bug Report',
  'Feature',
  'Documentation',
  'Analysis',
  'Report',
  'Proposal',
  'Presentation',
  'Workshop',
  'Training',
  'Onboarding',
  'Review',
  'Planning',
];

const NOTEBOOK_TOPICS = [
  'AI Integration',
  'Machine Learning',
  'Data Pipeline',
  'Frontend Redesign',
  'Backend Optimization',
  'Database Migration',
  'API Development',
  'Security Audit',
  'Performance Testing',
  'User Research',
  'Market Analysis',
  'Competitor Review',
  'Product Roadmap',
  'Technical Debt',
  'Infrastructure',
  'Cloud Migration',
  'DevOps',
  'CI/CD Pipeline',
  'Testing Strategy',
  'Documentation Update',
  'Customer Feedback',
  'Sales Pipeline',
  'Marketing Campaign',
  'Brand Strategy',
  'Financial Planning',
  'Risk Assessment',
  'Compliance Review',
  'Legal Review',
];

const NOTEBOOK_DATES = [
  'Q1 2024',
  'Q2 2024',
  'Q3 2024',
  'Q4 2024',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'Week 1',
  'Week 2',
  'Week 3',
  'Week 4',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
];

// Realistic tag pool (technologies, concepts, departments)
const TAG_POOL = [
  // Technologies
  'React',
  'TypeScript',
  'JavaScript',
  'Python',
  'Node.js',
  'GraphQL',
  'REST API',
  'MongoDB',
  'PostgreSQL',
  'Redis',
  'Docker',
  'Kubernetes',
  'AWS',
  'Azure',
  'GCP',
  'Terraform',
  'Jenkins',
  'GitHub Actions',
  'Webpack',
  'Vite',
  'Next.js',
  'Vue.js',
  'Angular',
  'Svelte',
  'TailwindCSS',
  'MUI',
  'Jest',
  'Playwright',

  // Concepts
  'Architecture',
  'Performance',
  'Security',
  'Testing',
  'Documentation',
  'Refactoring',
  'Optimization',
  'Scalability',
  'Monitoring',
  'Logging',
  'Analytics',
  'Metrics',
  'CI/CD',
  'DevOps',
  'Agile',
  'Scrum',
  'Kanban',
  'Code Review',
  'Best Practices',

  // Departments/Areas
  'Frontend',
  'Backend',
  'FullStack',
  'Mobile',
  'Desktop',
  'Web',
  'API',
  'Database',
  'Infrastructure',
  'Platform',
  'Product',
  'Design',
  'UX/UI',
  'Marketing',
  'Sales',
  'Support',
  'Operations',
  'Finance',
  'Legal',
  'HR',

  // Project Types
  'Feature',
  'Bug Fix',
  'Enhancement',
  'Research',
  'Prototype',
  'POC',
  'Migration',
  'Integration',
  'Automation',
  'Tool',
  'Library',
  'Framework',

  // Priorities/Status
  'High Priority',
  'Medium Priority',
  'Low Priority',
  'Urgent',
  'Blocked',
  'In Progress',
  'Review',
  'Testing',
  'Staging',
  'Production',
  'Archive',

  // Teams/Clients
  'Team Alpha',
  'Team Beta',
  'Team Gamma',
  'Client A',
  'Client B',
  'Internal',
  'External',
  'Partner',
  'Vendor',
  'Consultant',
  'Stakeholder',
  'Executive',
];

// Generate random notebook name
function generateNotebookName(index: number): string {
  const prefix = NOTEBOOK_PREFIXES[Math.floor(Math.random() * NOTEBOOK_PREFIXES.length)];
  const topic = NOTEBOOK_TOPICS[Math.floor(Math.random() * NOTEBOOK_TOPICS.length)];
  const date = NOTEBOOK_DATES[Math.floor(Math.random() * NOTEBOOK_DATES.length)];

  const formats = [
    `${prefix}: ${topic}`,
    `${topic} - ${date}`,
    `${prefix} - ${topic} (${date})`,
    `${topic} ${prefix}`,
    `${date} - ${prefix}: ${topic}`,
    `[${prefix}] ${topic}`,
    `${topic} v${Math.floor(Math.random() * 5) + 1}.${Math.floor(Math.random() * 10)}`,
  ];

  const name = formats[Math.floor(Math.random() * formats.length)];

  // Sometimes add a number suffix for uniqueness
  if (Math.random() > 0.7) {
    return `${name} #${index}`;
  }

  return name;
}

// Generate realistic tags with varying strengths
function generateTags(count: number): SessionTag[] {
  const tags: SessionTag[] = [];
  const selectedTags = new Set<string>();

  // Pick random tags from the pool
  while (selectedTags.size < count && selectedTags.size < TAG_POOL.length) {
    const tag = TAG_POOL[Math.floor(Math.random() * TAG_POOL.length)];
    if (!selectedTags.has(tag)) {
      selectedTags.add(tag);

      // Generate realistic strength distribution
      // Most tags have medium strength, few have very high or very low
      const random = Math.random();
      let strength: number;

      if (random < 0.1) {
        strength = Math.floor(Math.random() * 20) + 1; // 1-20 (low)
      } else if (random < 0.7) {
        strength = Math.floor(Math.random() * 60) + 21; // 21-80 (medium)
      } else {
        strength = Math.floor(Math.random() * 20) + 81; // 81-100 (high)
      }

      tags.push({
        name: tag,
        strength,
      });
    }
  }

  // Sort by strength (highest first)
  return tags.sort((a, b) => b.strength - a.strength);
}

// Generate a realistic date distribution
// More recent notebooks are more likely
function generateDate(index: number, total: number): Date {
  const now = new Date();
  const twoYearsAgo = new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);

  // Use exponential distribution for more recent bias
  const timeRange = now.getTime() - twoYearsAgo.getTime();

  // Exponential decay - more recent items have higher probability
  const random = Math.random();
  const exponentialFactor = Math.pow(random, 2); // Square for stronger recent bias
  const daysAgo = exponentialFactor * (timeRange / (24 * 60 * 60 * 1000));

  const date = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);

  return date;
}

// Generate large-scale mock notebook data
export function generateLargeScaleMockNotebooks(
  count: number = 4000,
  userId: string = 'mock-user-id'
): ISessionDocument[] {
  console.time('Generating mock notebooks');

  const notebooks: ISessionDocument[] = [];

  for (let i = 0; i < count; i++) {
    const createdDate = generateDate(i, count);
    const updatedDate = new Date(createdDate.getTime() + Math.random() * 7 * 24 * 60 * 60 * 1000);

    // Generate 10-25 tags per notebook
    const tagCount = Math.floor(Math.random() * 16) + 10; // 10-25 tags

    const notebook: ISessionDocument = {
      id: `mock-notebook-${i + 1}`,
      name: generateNotebookName(i + 1),
      userId,
      tags: generateTags(tagCount),
      firstCreated: createdDate,
      lastUpdated: updatedDate,
      createdAt: createdDate,
      updatedAt: updatedDate,
      tenantId: 'mock-tenant',
      orgId: 'mock-org',

      // Mock session-specific fields
      isDeleted: false,
      users: [],
      groups: [],
      isGlobalRead: false,
      isGlobalWrite: false,
    } as ISessionDocument;

    notebooks.push(notebook);
  }

  // Sort by lastUpdated (most recent first)
  notebooks.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());

  console.timeEnd('Generating mock notebooks');

  // Log some statistics
  const tagStats = new Map<string, number>();
  notebooks.forEach(notebook => {
    notebook.tags?.forEach(tag => {
      tagStats.set(tag.name, (tagStats.get(tag.name) || 0) + 1);
    });
  });

  console.log(`Generated ${count} notebooks with:
    - Average tags per notebook: ${notebooks.reduce((sum, n) => sum + (n.tags?.length || 0), 0) / count}
    - Unique tags: ${tagStats.size}
    - Most common tag: ${Array.from(tagStats.entries()).sort((a, b) => b[1] - a[1])[0]?.[0]}
    - Date range: ${notebooks[notebooks.length - 1].lastUpdated} to ${notebooks[0].lastUpdated}
  `);

  return notebooks;
}

// Performance testing harness
export function runPerformanceTest(notebooks: ISessionDocument[]): void {
  console.group('🚀 Performance Test Results');

  // Test 1: Initial render time
  console.time('Initial tag processing (first 21)');
  const first21 = notebooks.slice(0, 21);
  const initialTags = new Map<string, number>();
  first21.forEach(notebook => {
    if (notebook.tags && notebook.tags.length > 0) {
      const highestTag = notebook.tags[0]; // Already sorted by strength
      initialTags.set(highestTag.name, (initialTags.get(highestTag.name) || 0) + 1);
    }
  });
  console.timeEnd('Initial tag processing (first 21)');
  console.log(`Initial tags found: ${initialTags.size}`);

  // Test 2: Fibonacci batch processing simulation
  const fibonacciBatches = [21, 34, 55, 89, 144, 233, 377, 610, 987];
  let processed = 0;

  console.time('Full Fibonacci processing');
  fibonacciBatches.forEach((batchSize, index) => {
    const start = processed;
    const end = Math.min(processed + batchSize, notebooks.length);
    const batch = notebooks.slice(start, end);

    console.time(`Batch ${index + 1} (${batch.length} notebooks)`);
    const batchTags = new Map<string, number>();
    batch.forEach(notebook => {
      if (notebook.tags && notebook.tags.length > 0) {
        const highestTag = notebook.tags[0];
        batchTags.set(highestTag.name, (batchTags.get(highestTag.name) || 0) + 1);
      }
    });
    console.timeEnd(`Batch ${index + 1} (${batch.length} notebooks)`);

    processed = end;
    if (processed >= notebooks.length) {
      console.timeEnd('Full Fibonacci processing');
      return;
    }
  });
  console.timeEnd('Full Fibonacci processing');

  // Test 3: Full processing (baseline)
  console.time('Full tag processing (all notebooks)');
  const allTags = new Map<string, number>();
  notebooks.forEach(notebook => {
    if (notebook.tags && notebook.tags.length > 0) {
      const highestTag = notebook.tags[0];
      allTags.set(highestTag.name, (allTags.get(highestTag.name) || 0) + 1);
    }
  });
  console.timeEnd('Full tag processing (all notebooks)');

  console.log(`
Performance Summary:
- Total notebooks: ${notebooks.length}
- Total unique tag groups: ${allTags.size}
- Average notebooks per tag: ${Math.round(notebooks.length / allTags.size)}
- Tags visible after first batch: ${initialTags.size} (${Math.round((initialTags.size / allTags.size) * 100)}% of total)
  `);

  console.groupEnd();
}

// Export a flag to enable/disable test mode
export const ENABLE_LARGE_SCALE_TEST = false; // Set to true to enable testing

// Test runner (only runs when flag is true)
if (ENABLE_LARGE_SCALE_TEST && typeof window !== 'undefined') {
  console.log('🔬 Running large-scale notebook test...');
  const testNotebooks = generateLargeScaleMockNotebooks(4000);

  // Store globally for debugging
  (window as any).__testNotebooks = testNotebooks;

  // Run performance tests
  runPerformanceTest(testNotebooks);

  console.log('Test notebooks available at: window.__testNotebooks');
}
