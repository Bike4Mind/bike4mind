// B4M monorepo dependency data: packages, dependencies, and relationships

export interface PackageInfo {
  name: string;
  version: string;
  description: string;
  type: 'app' | 'package' | 'core';
  keyDependencies: DependencyInfo[];
  workspaceDependencies: string[];
}

export interface DependencyInfo {
  name: string;
  version: string;
  category: string;
}

export interface DependencyCategory {
  name: string;
  description: string;
  color: string;
}

// Dependency categories

export const DEPENDENCY_CATEGORIES: DependencyCategory[] = [
  {
    name: 'UI Framework',
    description: 'Frontend frameworks, component libraries, and rendering engines',
    color: 'blue',
  },
  {
    name: 'AI/LLM',
    description: 'Large language model SDKs and AI integration libraries',
    color: 'purple',
  },
  {
    name: 'AWS Services',
    description: 'AWS SDK clients for cloud infrastructure',
    color: 'orange',
  },
  {
    name: 'Database',
    description: 'Database drivers, ODMs, and search engines',
    color: 'green',
  },
  {
    name: 'Authentication',
    description: 'Auth, encryption, and access control libraries',
    color: 'red',
  },
  {
    name: 'File Processing',
    description: 'Image manipulation, document parsing, and file handling',
    color: 'teal',
  },
  {
    name: 'Testing',
    description: 'Test runners, assertion libraries, and E2E frameworks',
    color: 'gray',
  },
  {
    name: 'Communication',
    description: 'Slack, email, WebSocket, and messaging integrations',
    color: 'indigo',
  },
  {
    name: 'Utilities',
    description: 'General-purpose utility libraries and helpers',
    color: 'neutral',
  },
];

// Packages

export const PACKAGES: PackageInfo[] = [
  // ---- Applications ----
  {
    name: '@bike4mind/client',
    version: '0.1.0',
    description: 'Next.js 16.1.6 frontend + API routes',
    type: 'app',
    keyDependencies: [
      { name: 'next', version: '16.1.6', category: 'UI Framework' },
      { name: 'react', version: '19.2.4', category: 'UI Framework' },
      { name: '@mui/joy', version: '5.0.0-beta.52', category: 'UI Framework' },
      { name: '@tanstack/react-router', version: '1.166.6', category: 'UI Framework' },
      { name: 'zustand', version: '4.5.4', category: 'UI Framework' },
      { name: 'openai', version: '6.27.0', category: 'AI/LLM' },
      { name: '@anthropic-ai/sdk', version: '0.71.2', category: 'AI/LLM' },
      { name: '@playwright/test', version: '1.58.2', category: 'Testing' },
    ],
    workspaceDependencies: [
      '@bike4mind/database',
      '@bike4mind/common',
      '@bike4mind/services',
      '@bike4mind/utils',
      '@bike4mind/agents',
      '@bike4mind/slack',
      '@bike4mind/mcp',
    ],
  },
  {
    name: '@bike4mind/cli',
    version: '0.2.48',
    description: 'Interactive CLI with ReAct agents',
    type: 'app',
    keyDependencies: [
      { name: 'openai', version: '6.27.0', category: 'AI/LLM' },
      { name: '@anthropic-ai/sdk', version: '0.71.2', category: 'AI/LLM' },
      { name: '@google/genai', version: '1.44.0', category: 'AI/LLM' },
      { name: 'ollama', version: '0.6.3', category: 'AI/LLM' },
      { name: '@modelcontextprotocol/sdk', version: '1.27.1', category: 'AI/LLM' },
      { name: 'ink', version: '6.8.0', category: 'UI Framework' },
      { name: 'better-sqlite3', version: '12.6.2', category: 'Database' },
    ],
    workspaceDependencies: [
      '@bike4mind/agents',
      '@bike4mind/common',
      '@bike4mind/mcp',
      '@bike4mind/services',
      '@bike4mind/utils',
    ],
  },
  {
    name: 'subscriber-fanout',
    version: '1.0.0',
    description: 'WebSocket subscription service (ECS)',
    type: 'app',
    keyDependencies: [
      { name: 'mongoose', version: '8.8.3', category: 'Database' },
      { name: 'zod', version: '4.3.6', category: 'Utilities' },
      {
        name: '@aws-sdk/client-apigatewaymanagementapi',
        version: 'latest',
        category: 'AWS Services',
      },
    ],
    workspaceDependencies: ['@bike4mind/common'],
  },

  // ---- Packages ----
  {
    name: '@bike4mind/database',
    version: '0.1.0',
    description: '109 Mongoose models',
    type: 'package',
    keyDependencies: [
      { name: 'mongoose', version: '8.8.3', category: 'Database' },
      { name: '@casl/ability', version: '6.8.0', category: 'Authentication' },
      { name: 'bcryptjs', version: '2.4.3', category: 'Authentication' },
    ],
    workspaceDependencies: ['@bike4mind/common', '@bike4mind/utils'],
  },
  {
    name: '@bike4mind/scripts',
    version: '0.1.0',
    description: 'Migrations & data tools',
    type: 'package',
    keyDependencies: [
      { name: 'yargs', version: 'latest', category: 'Utilities' },
      { name: 'inquirer', version: 'latest', category: 'Utilities' },
      { name: '@faker-js/faker', version: 'latest', category: 'Testing' },
      { name: 'csv-parser', version: 'latest', category: 'File Processing' },
    ],
    workspaceDependencies: ['@bike4mind/database', '@bike4mind/common', '@bike4mind/services', '@bike4mind/utils'],
  },

  // ---- Core Packages ----
  {
    name: '@bike4mind/common',
    version: '2.67.0',
    description: 'Shared types (582+ exports)',
    type: 'core',
    keyDependencies: [
      { name: 'zod', version: '4.3.6', category: 'Utilities' },
      { name: 'dayjs', version: '1.11.19', category: 'Utilities' },
      { name: 'react', version: '19.2.4', category: 'UI Framework' },
    ],
    workspaceDependencies: [],
  },
  {
    name: '@bike4mind/services',
    version: '2.63.0',
    description: 'Business logic (47+ modules)',
    type: 'core',
    keyDependencies: [
      { name: '@anthropic-ai/sdk', version: '0.71.2', category: 'AI/LLM' },
      { name: 'openai', version: '6.27.0', category: 'AI/LLM' },
      { name: '@google/genai', version: '1.44.0', category: 'AI/LLM' },
      { name: '@mendable/firecrawl-js', version: '1.29.3', category: 'AI/LLM' },
      { name: '@opensearch-project/opensearch', version: '2.11.0', category: 'Database' },
      { name: 'mongoose', version: '8.8.3', category: 'Database' },
      { name: 'tiktoken', version: 'latest', category: 'AI/LLM' },
    ],
    workspaceDependencies: ['@bike4mind/agents', '@bike4mind/common', '@bike4mind/mcp', '@bike4mind/utils'],
  },
  {
    name: '@bike4mind/utils',
    version: '2.15.3',
    description: 'AWS wrappers, LLM utilities',
    type: 'core',
    keyDependencies: [
      { name: '@aws-sdk/client-s3', version: 'latest', category: 'AWS Services' },
      { name: '@aws-sdk/client-sqs', version: 'latest', category: 'AWS Services' },
      { name: '@aws-sdk/client-lambda', version: 'latest', category: 'AWS Services' },
      { name: 'openai', version: '6.27.0', category: 'AI/LLM' },
      { name: '@anthropic-ai/sdk', version: '0.71.2', category: 'AI/LLM' },
      { name: '@google/genai', version: 'latest', category: 'AI/LLM' },
      { name: 'voyageai', version: 'latest', category: 'AI/LLM' },
      { name: 'ollama', version: 'latest', category: 'AI/LLM' },
      { name: 'sharp', version: 'latest', category: 'File Processing' },
      { name: 'tiktoken', version: 'latest', category: 'AI/LLM' },
    ],
    workspaceDependencies: ['@bike4mind/common'],
  },
  {
    name: '@bike4mind/agents',
    version: '0.1.0',
    description: 'Agent framework',
    type: 'core',
    keyDependencies: [],
    workspaceDependencies: ['@bike4mind/common', '@bike4mind/utils'],
  },
  {
    name: '@bike4mind/mcp',
    version: '1.33.10',
    description: 'MCP servers',
    type: 'core',
    keyDependencies: [
      { name: '@modelcontextprotocol/sdk', version: '1.27.1', category: 'AI/LLM' },
      { name: 'octokit', version: '22.0.1', category: 'Communication' },
      { name: '@anthropic-ai/sdk', version: '0.71.2', category: 'AI/LLM' },
    ],
    workspaceDependencies: ['@bike4mind/common'],
  },
  {
    name: '@bike4mind/slack',
    version: '0.0.1',
    description: 'Slack integration',
    type: 'core',
    keyDependencies: [
      { name: '@slack/web-api', version: '7.14.1', category: 'Communication' },
      { name: '@slack/oauth', version: '3.0.4', category: 'Communication' },
      { name: 'cheerio', version: 'latest', category: 'File Processing' },
      { name: 'chrono-node', version: 'latest', category: 'Utilities' },
    ],
    workspaceDependencies: [
      '@bike4mind/agents',
      '@bike4mind/common',
      '@bike4mind/mcp',
      '@bike4mind/services',
      '@bike4mind/utils',
    ],
  },

  // ---- Config Packages ----
  {
    name: '@bike4mind/typescript-config',
    version: '1.0.0',
    description: 'Shared TypeScript configuration',
    type: 'package',
    keyDependencies: [],
    workspaceDependencies: [],
  },
  {
    name: '@bike4mind/eslint-config',
    version: '1.0.0',
    description: 'Shared ESLint configuration',
    type: 'package',
    keyDependencies: [],
    workspaceDependencies: [],
  },
];

// Shared (cross-cutting) dependencies

export interface SharedDependency {
  name: string;
  version: string;
  usedByCount: number;
  category: string;
}

export const SHARED_DEPENDENCIES: SharedDependency[] = [
  { name: 'zod', version: '4.3.6', usedByCount: 15, category: 'Utilities' },
  { name: 'dayjs', version: '1.11.19', usedByCount: 10, category: 'Utilities' },
  { name: 'mongoose', version: '8.8.3', usedByCount: 5, category: 'Database' },
  { name: 'lodash', version: '4.17.21', usedByCount: 8, category: 'Utilities' },
  { name: 'axios', version: '1.13.6', usedByCount: 8, category: 'Utilities' },
  { name: 'typescript', version: '5.9.3', usedByCount: 14, category: 'Utilities' },
  { name: '@anthropic-ai/sdk', version: '0.71.2', usedByCount: 4, category: 'AI/LLM' },
  { name: 'openai', version: '6.27.0', usedByCount: 4, category: 'AI/LLM' },
];

// Dependency flow graph

export const DEPENDENCY_FLOW = `\
@bike4mind/common (leaf)
  \u2193
@bike4mind/utils (mid-tier)
  \u2193
@bike4mind/agents, @bike4mind/mcp (mid-tier)
  \u2193
@bike4mind/services (heavy - integrates all)
  \u2193
@bike4mind/client, @bike4mind/cli (applications)`;
