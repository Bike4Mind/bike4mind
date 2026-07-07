import fs from 'fs';
import path from 'path';

export interface TestUser {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

interface TestInviteCode {
  id: string;
  code: string;
}

interface CoreData {
  admin: TestUser;
  manager: TestUser;
  inviteCode?: TestInviteCode;
}

interface TestUsers {
  admin: TestUser;
  user: TestUser;
  manager: TestUser;
  specUsers: Record<string, TestUser>;
  inviteCode?: TestInviteCode;
}

const AUTH_DIR = path.resolve(__dirname, '../.auth');
const CORE_DATA_PATH = path.resolve(AUTH_DIR, 'core-data.json');
const TEST_RUN_ID_PATH = path.resolve(AUTH_DIR, 'test-run-id');

const SPEC_KEYS = [
  'prompts',
  'notebook',
  'notebookFiles',
  'projects',
  'agents',
  'imageGen',
  'profile',
  'tavern',
  'search',
  'dataLake',
  'skills',
];

/**
 * E2E test ID from env, sanitized to alphanumeric. Empty string if unset.
 * Used to isolate test data between multiple testers on shared preview builds.
 */
export function getE2ETestId(): string {
  const id = process.env.E2E_TEST_ID?.replace(/[^a-zA-Z0-9]/g, '') ?? '';
  return id;
}

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

export function saveTestRunId(id: string): void {
  ensureAuthDir();
  fs.writeFileSync(TEST_RUN_ID_PATH, id);
}

export function getTestRunId(): string {
  if (!fs.existsSync(TEST_RUN_ID_PATH)) {
    throw new Error('Test run ID file not found — core.setup.ts must run first');
  }
  return fs.readFileSync(TEST_RUN_ID_PATH, 'utf-8').trim();
}

export function saveCoreData(data: CoreData): void {
  ensureAuthDir();
  fs.writeFileSync(CORE_DATA_PATH, JSON.stringify(data, null, 2));
}

export function saveSpecUser(key: string, user: TestUser): void {
  ensureAuthDir();
  fs.writeFileSync(path.resolve(AUTH_DIR, `${key}-data.json`), JSON.stringify(user, null, 2));
}

export function getTestUsers(): TestUsers {
  if (!fs.existsSync(CORE_DATA_PATH)) {
    throw new Error('Core data file not found — core.setup.ts must run first');
  }
  const core: CoreData = JSON.parse(fs.readFileSync(CORE_DATA_PATH, 'utf-8'));

  const specUsers: Record<string, TestUser> = {};
  for (const key of SPEC_KEYS) {
    const filePath = path.resolve(AUTH_DIR, `${key}-data.json`);
    if (fs.existsSync(filePath)) {
      specUsers[key] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  }

  // Backward-compat: 'user' aliases the projects spec user
  const user = specUsers.projects || Object.values(specUsers)[0];

  return {
    admin: core.admin,
    user,
    manager: core.manager,
    specUsers,
    inviteCode: core.inviteCode,
  };
}
