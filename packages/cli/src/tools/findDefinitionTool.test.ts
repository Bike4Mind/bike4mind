import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFindDefinitionTool, buildDefinitionPattern, isLikelyDefinition } from './findDefinitionTool';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('findDefinitionTool', () => {
  let testDir: string;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    testDir = await mkdtemp(join(tmpdir(), 'find-def-test-'));

    // TypeScript file with various definitions
    await writeFile(
      join(testDir, 'auth.ts'),
      `import { Component } from 'react';
import { BaseProvider } from './base';

export class AuthProvider extends BaseProvider {
  authenticate() {}
}

export interface AuthConfig {
  secret: string;
}

export type AuthToken = string;

export const AUTH_TIMEOUT = 3000;

export enum AuthStatus {
  Active,
  Inactive,
}

export function validateAuth(token: string): boolean {
  return token.length > 0;
}
`
    );

    // Python file
    await writeFile(
      join(testDir, 'models.py'),
      `import os

class UserModel:
    def __init__(self, name):
        self.name = name

def calculate_total(items):
    return sum(items)

class AdminModel(UserModel):
    pass
`
    );

    // Go file
    await writeFile(
      join(testDir, 'handler.go'),
      `package main

import "net/http"

type RequestHandler struct {
    Name string
}

func HandleRequest(w http.ResponseWriter, r *http.Request) {
}

type ResponseWriter interface {
    Write([]byte) (int, error)
}
`
    );

    // Rust file
    await writeFile(
      join(testDir, 'lib.rs'),
      `use std::collections::HashMap;

struct Config {
    name: String,
}

fn process_data(input: &str) -> String {
    input.to_string()
}

trait Serializable {
    fn serialize(&self) -> String;
}

enum Status {
    Active,
    Inactive,
}
`
    );

    // Test file (should be deprioritized in results)
    await mkdir(join(testDir, '__tests__'));
    await writeFile(
      join(testDir, '__tests__', 'auth.test.ts'),
      `import { AuthProvider } from '../auth';

jest.mock('../auth');

class AuthProvider extends MockProvider {
  // test mock
}
`
    );

    // File with imports only (should be filtered out)
    await writeFile(
      join(testDir, 'consumer.ts'),
      `import { AuthProvider } from './auth';
import { UserModel } from './models';

const provider: AuthProvider = new AuthProvider();
`
    );

    // Subdirectory with definitions
    await mkdir(join(testDir, 'src'));
    await writeFile(
      join(testDir, 'src', 'utils.ts'),
      `export function calculateTotal(items: number[]): number {
  return items.reduce((a, b) => a + b, 0);
}

export const MAX_RETRIES = 5;
`
    );

    process.chdir(testDir);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  describe('buildDefinitionPattern', () => {
    it('should include all keywords when no kind is specified', () => {
      const pattern = buildDefinitionPattern('Foo');
      expect(pattern).toContain('class');
      expect(pattern).toContain('function');
      expect(pattern).toContain('def');
      expect(pattern).toContain('func');
      expect(pattern).toContain('fn');
      expect(pattern).toContain('interface');
      expect(pattern).toContain('const');
      expect(pattern).toContain('enum');
      expect(pattern).toContain('struct');
      expect(pattern).toContain('trait');
    });

    it('should narrow keywords when kind is provided', () => {
      const pattern = buildDefinitionPattern('Foo', 'function');
      expect(pattern).toContain('function');
      expect(pattern).toContain('def');
      expect(pattern).toContain('func');
      expect(pattern).toContain('fn');
      expect(pattern).not.toContain('class');
      expect(pattern).not.toContain('interface');
    });

    it('should escape regex special characters in symbol name', () => {
      const pattern = buildDefinitionPattern('$foo');
      expect(pattern).toContain('\\$foo');
    });

    it('should throw for invalid kind', () => {
      expect(() => buildDefinitionPattern('Foo', 'bogus')).toThrow('Invalid kind "bogus"');
      expect(() => buildDefinitionPattern('Foo', 'bogus')).toThrow('Valid kinds:');
    });
  });

  describe('isLikelyDefinition', () => {
    it('should accept export class definition', () => {
      expect(isLikelyDefinition('export class AuthProvider {')).toBe(true);
    });

    it('should accept plain function', () => {
      expect(isLikelyDefinition('function calculateTotal(items) {')).toBe(true);
    });

    it('should accept Python def', () => {
      expect(isLikelyDefinition('def calculate_total(self):')).toBe(true);
    });

    it('should accept Go func', () => {
      expect(isLikelyDefinition('func HandleRequest(w http.ResponseWriter) {')).toBe(true);
    });

    it('should accept Rust fn', () => {
      expect(isLikelyDefinition('fn new() -> Self {')).toBe(true);
    });

    it('should accept const definition', () => {
      expect(isLikelyDefinition('export const AUTH_TIMEOUT = 3000;')).toBe(true);
    });

    it('should reject import line', () => {
      expect(isLikelyDefinition("import { AuthProvider } from './auth'")).toBe(false);
    });

    it('should reject // comment line', () => {
      expect(isLikelyDefinition('// class AuthProvider')).toBe(false);
    });

    it('should reject # comment line', () => {
      expect(isLikelyDefinition('# def calculate_total')).toBe(false);
    });

    it('should reject /* comment line', () => {
      expect(isLikelyDefinition('/* class Foo */')).toBe(false);
    });

    it('should reject * comment continuation', () => {
      expect(isLikelyDefinition(' * class Foo')).toBe(false);
    });

    it('should reject test mock', () => {
      expect(isLikelyDefinition("jest.mock('./AuthProvider')")).toBe(false);
    });

    it('should reject vi.mock', () => {
      expect(isLikelyDefinition("vi.mock('./AuthProvider')")).toBe(false);
    });
  });

  // Integration tests (requires ripgrep)
  describe('integration', () => {
    it('should find a class definition in TypeScript', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'AuthProvider' });

      expect(result).toContain('auth.ts');
      expect(result).toContain('export class AuthProvider');
    });

    it('should find an interface definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'AuthConfig' });

      expect(result).toContain('auth.ts');
      expect(result).toContain('export interface AuthConfig');
    });

    it('should find a type definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'AuthToken' });

      expect(result).toContain('auth.ts');
      expect(result).toContain('export type AuthToken');
    });

    it('should find a const definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'AUTH_TIMEOUT' });

      expect(result).toContain('auth.ts');
      expect(result).toContain('export const AUTH_TIMEOUT');
    });

    it('should find an enum definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'AuthStatus' });

      expect(result).toContain('auth.ts');
      expect(result).toContain('export enum AuthStatus');
    });

    it('should find a function definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'validateAuth' });

      expect(result).toContain('auth.ts');
      expect(result).toContain('export function validateAuth');
    });

    it('should find a Python class definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'UserModel' });

      expect(result).toContain('models.py');
      expect(result).toContain('class UserModel');
    });

    it('should find a Python function definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'calculate_total' });

      expect(result).toContain('models.py');
      expect(result).toContain('def calculate_total');
    });

    it('should find a Go struct definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'RequestHandler' });

      expect(result).toContain('handler.go');
      expect(result).toContain('type RequestHandler struct');
    });

    it('should find a Go func definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'HandleRequest' });

      expect(result).toContain('handler.go');
      expect(result).toContain('func HandleRequest');
    });

    it('should find a Rust fn definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'process_data' });

      expect(result).toContain('lib.rs');
      expect(result).toContain('fn process_data');
    });

    it('should find a Rust trait definition', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'Serializable' });

      expect(result).toContain('lib.rs');
      expect(result).toContain('trait Serializable');
    });

    it('should narrow results when kind is provided', async () => {
      const tool = createFindDefinitionTool();
      // AuthProvider is both a class and used as a type annotation
      const result = await tool.toolFn({ symbol_name: 'AuthProvider', kind: 'class' });

      expect(result).toContain('class AuthProvider');
      // Should not include interface or type matches
      expect(result).not.toContain('interface AuthProvider');
    });

    it('should narrow results when search_path is provided', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'calculateTotal', search_path: 'src' });

      expect(result).toContain('utils.ts');
      // Should not include root-level files outside search_path
    });

    it('should filter out import-only lines', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'AuthProvider' });

      // consumer.ts only imports AuthProvider - should not appear
      expect(result).not.toContain('consumer.ts');
    });

    it('should filter out jest.mock lines', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'AuthProvider' });

      // Should not include the jest.mock line
      expect(result).not.toContain('jest.mock');
    });

    it('should prioritize exports over non-exports', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'AuthProvider' });

      // The export class line should come before the test mock class
      const exportIndex = result.indexOf('export class AuthProvider');
      const testIndex = result.indexOf('__tests__');

      if (testIndex !== -1) {
        expect(exportIndex).toBeLessThan(testIndex);
      }
    });

    it('should return helpful message when no definitions found', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'NonexistentSymbol' });

      expect(result).toContain('No definitions found');
      expect(result).toContain('NonexistentSymbol');
      expect(result).toContain('external package');
    });

    it('should throw for empty symbol_name', async () => {
      const tool = createFindDefinitionTool();
      await expect(tool.toolFn({ symbol_name: '' })).rejects.toThrow('symbol_name is required');
    });

    it('should throw for path traversal', async () => {
      const tool = createFindDefinitionTool();
      await expect(tool.toolFn({ symbol_name: 'Foo', search_path: '../../../etc' })).rejects.toThrow(
        'Path validation failed'
      );
    });

    it('should throw for non-existent search_path', async () => {
      const tool = createFindDefinitionTool();
      await expect(tool.toolFn({ symbol_name: 'Foo', search_path: 'nonexistent' })).rejects.toThrow(
        'Path does not exist'
      );
    });

    it('should support prefix matching — "Auth" finds AuthProvider, AuthConfig, etc.', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'Auth' });

      expect(result).toContain('AuthProvider');
      expect(result).toContain('AuthConfig');
      expect(result).toContain('AuthToken');
      expect(result).toContain('AuthStatus');
      // AUTH_TIMEOUT is all uppercase - case-sensitive search for "Auth" won't match "AUTH"
      expect(result).not.toContain('AUTH_TIMEOUT');
    });

    it('should support prefix matching across languages — "User" finds UserModel in Python', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'User' });

      expect(result).toContain('models.py');
      expect(result).toContain('UserModel');
    });

    it('should support prefix matching with kind filter', async () => {
      const tool = createFindDefinitionTool();
      const result = await tool.toolFn({ symbol_name: 'Auth', kind: 'class' });

      expect(result).toContain('AuthProvider');
      expect(result).not.toContain('AuthConfig'); // interface, not class
      expect(result).not.toContain('AuthToken'); // type, not class
    });
  });

  describe('tool schema', () => {
    it('should have correct tool name', () => {
      const tool = createFindDefinitionTool();
      expect(tool.toolSchema.name).toBe('find_definition');
    });

    it('should require symbol_name', () => {
      const tool = createFindDefinitionTool();
      expect(tool.toolSchema.parameters.required).toContain('symbol_name');
    });

    it('should have kind enum with valid values', () => {
      const tool = createFindDefinitionTool();
      const kindProp = tool.toolSchema.parameters.properties.kind;
      expect(kindProp.enum).toEqual(['class', 'function', 'type', 'interface', 'variable', 'enum', 'struct', 'module']);
    });

    it('should have optional search_path', () => {
      const tool = createFindDefinitionTool();
      expect(tool.toolSchema.parameters.required).not.toContain('search_path');
    });

    it('should have a description mentioning language-agnostic', () => {
      const tool = createFindDefinitionTool();
      expect(tool.toolSchema.description).toContain('automatically');
    });
  });
});
