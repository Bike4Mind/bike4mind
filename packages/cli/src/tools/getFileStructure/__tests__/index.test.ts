import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createGetFileStructureTool } from '../index';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('createGetFileStructureTool', () => {
  let testDir: string;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    testDir = await mkdtemp(join(tmpdir(), 'get-file-structure-test-'));
    process.chdir(testDir);

    // TypeScript test file
    await writeFile(
      join(testDir, 'sample.ts'),
      `import { useState } from 'react';
import path from 'path';

export interface UserConfig {
  name: string;
  age: number;
}

export type Status = 'active' | 'inactive';

export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async findById(id: string) {
    return this.db.find(id);
  }
}

export function createUser(name: string): User {
  return { name, id: generateId() };
}

export const deleteUser = async (id: string) => {
  await db.delete(id);
};

const helperFn = () => {
  return 42;
};

export enum Role {
  Admin = 'admin',
  User = 'user',
}
`
    );

    // Python test file
    await writeFile(
      join(testDir, 'sample.py'),
      `import os
from pathlib import Path
from typing import List, Optional

class UserService:
    def __init__(self, db):
        self.db = db

    def find_by_id(self, user_id: str):
        return self.db.find(user_id)

def create_user(name: str) -> dict:
    return {"name": name}

async def delete_user(user_id: str) -> None:
    await db.delete(user_id)
`
    );

    // Empty file
    await writeFile(join(testDir, 'empty.ts'), '');

    // JavaScript file
    await writeFile(
      join(testDir, 'utils.js'),
      `const lodash = require('lodash');

function formatName(first, last) {
  return \`\${first} \${last}\`;
}

module.exports = { formatName };
`
    );
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  it('should extract TypeScript structure', async () => {
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: 'sample.ts' });

    // Check file header
    expect(result).toContain('File: sample.ts');
    expect(result).toContain('lines)');

    // Check imports
    expect(result).toContain('IMPORTS');
    expect(result).toContain('react');
    expect(result).toContain('path');

    // Check functions
    expect(result).toContain('FUNCTIONS');
    expect(result).toContain('createUser');
    expect(result).toContain('deleteUser');
    expect(result).toContain('helperFn');

    // Check classes
    expect(result).toContain('CLASSES');
    expect(result).toContain('UserService');

    // Check interfaces
    expect(result).toContain('INTERFACES');
    expect(result).toContain('UserConfig');

    // Check types
    expect(result).toContain('TYPES');
    expect(result).toContain('Status');
  });

  it('should extract Python structure', async () => {
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: 'sample.py' });

    // Check imports
    expect(result).toContain('IMPORTS');
    expect(result).toContain('os');
    expect(result).toContain('pathlib');

    // Check functions
    expect(result).toContain('FUNCTIONS');
    expect(result).toContain('create_user');
    expect(result).toContain('delete_user');

    // Check classes
    expect(result).toContain('CLASSES');
    expect(result).toContain('UserService');
  });

  it('should handle empty files', async () => {
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: 'empty.ts' });

    expect(result).toContain('File: empty.ts');
    expect(result).toContain('(none)');
  });

  it('should handle JavaScript files', async () => {
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: 'utils.js' });

    expect(result).toContain('FUNCTIONS');
    expect(result).toContain('formatName');
  });

  it('should return error for unsupported file types', async () => {
    await writeFile(join(testDir, 'config.yaml'), 'key: value');
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: 'config.yaml' });

    expect(result).toContain('Error');
    expect(result).toContain('Unsupported file type');
  });

  it('should return error for non-existent file', async () => {
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: 'nonexistent.ts' });

    expect(result).toContain('Error');
    expect(result).toContain('File not found');
  });

  it('should prevent path traversal', async () => {
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: '../../../etc/passwd' });

    expect(result).toContain('Error');
    expect(result).toContain('Access denied');
  });

  it('should return error for directories', async () => {
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: '.' });

    expect(result).toContain('Error');
    expect(result).toContain('directory');
  });

  it('should show line numbers', async () => {
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: 'sample.ts' });

    // Line numbers should be present in the output (e.g., "L1:", "L4:")
    expect(result).toMatch(/L\d+:/);
  });

  it('should mark exported items', async () => {
    const tool = createGetFileStructureTool();
    const result = await tool.toolFn({ path: 'sample.ts' });

    // Exported functions/classes should be marked
    expect(result).toMatch(/export\s+createUser/);
    expect(result).toMatch(/export\s+UserService/);
  });

  it('should have correct tool schema', () => {
    const tool = createGetFileStructureTool();

    expect(tool.toolSchema.name).toBe('get_file_structure');
    expect(tool.toolSchema.parameters.required).toContain('path');
    expect(tool.toolSchema.parameters.properties).toHaveProperty('path');
  });
});
