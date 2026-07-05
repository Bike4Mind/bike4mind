import { describe, it, expect } from 'vitest';
import { parseFileStructure, getSupportedLanguages, getLanguageForExtension } from '../treeSitterEngine';

describe('treeSitterEngine', () => {
  describe('parseFileStructure', () => {
    it('should extract function declarations from TypeScript', async () => {
      const source = `
function greet(name: string): string {
  return \`Hello, \${name}\`;
}

async function fetchData(url: string) {
  return fetch(url);
}
`;
      const items = await parseFileStructure(source, 'typescript');
      const functions = items.filter(i => i.kind === 'function');

      expect(functions).toHaveLength(2);
      expect(functions[0].name).toBe('greet');
      expect(functions[1].name).toBe('fetchData');
    });

    it('should extract arrow functions from TypeScript', async () => {
      const source = `
const add = (a: number, b: number) => a + b;
const multiply = (a: number, b: number) => {
  return a * b;
};
`;
      const items = await parseFileStructure(source, 'typescript');
      const functions = items.filter(i => i.kind === 'function');

      expect(functions).toHaveLength(2);
      expect(functions.find(f => f.name === 'add')).toBeDefined();
      expect(functions.find(f => f.name === 'multiply')).toBeDefined();
    });

    it('should extract class declarations', async () => {
      const source = `
class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

class Dog extends Animal {
  bark() { return 'woof'; }
}
`;
      const items = await parseFileStructure(source, 'typescript');
      const classes = items.filter(i => i.kind === 'class');

      expect(classes).toHaveLength(2);
      expect(classes[0].name).toBe('Animal');
      expect(classes[1].name).toBe('Dog');
    });

    it('should extract interface declarations', async () => {
      const source = `
interface Point {
  x: number;
  y: number;
}

interface Shape extends Point {
  area(): number;
}
`;
      const items = await parseFileStructure(source, 'typescript');
      const interfaces = items.filter(i => i.kind === 'interface');

      expect(interfaces).toHaveLength(2);
      expect(interfaces[0].name).toBe('Point');
      expect(interfaces[1].name).toBe('Shape');
    });

    it('should extract type aliases', async () => {
      const source = `
type Color = 'red' | 'green' | 'blue';
type Point = { x: number; y: number };
`;
      const items = await parseFileStructure(source, 'typescript');
      const types = items.filter(i => i.kind === 'type');

      expect(types).toHaveLength(2);
      expect(types[0].name).toBe('Color');
      expect(types[1].name).toBe('Point');
    });

    it('should extract import statements', async () => {
      const source = `
import { useState, useEffect } from 'react';
import path from 'path';
import type { Config } from './types';
`;
      const items = await parseFileStructure(source, 'typescript');
      const imports = items.filter(i => i.kind === 'import');

      expect(imports.length).toBeGreaterThanOrEqual(2);
      expect(imports.find(i => i.name === 'react')).toBeDefined();
      expect(imports.find(i => i.name === 'path')).toBeDefined();
    });

    it('should extract export statements', async () => {
      const source = `
export function createUser() {}
export class UserService {}
export const API_KEY = 'test';
export type Status = 'on' | 'off';
export interface Config { key: string; }
`;
      const items = await parseFileStructure(source, 'typescript');

      // Exported items should be marked
      const exportedFn = items.find(i => i.kind === 'function' && i.name === 'createUser');
      expect(exportedFn?.exported).toBe(true);

      const exportedClass = items.find(i => i.kind === 'class' && i.name === 'UserService');
      expect(exportedClass?.exported).toBe(true);
    });

    it('should handle empty source code', async () => {
      const items = await parseFileStructure('', 'typescript');
      expect(items).toHaveLength(0);
    });

    it('should extract Python functions and classes', async () => {
      const source = `
import os
from typing import List

class Calculator:
    def add(self, a, b):
        return a + b

def multiply(a, b):
    return a * b
`;
      const items = await parseFileStructure(source, 'python');

      const classes = items.filter(i => i.kind === 'class');
      expect(classes).toHaveLength(1);
      expect(classes[0].name).toBe('Calculator');

      const functions = items.filter(i => i.kind === 'function');
      // Should include both top-level and class methods
      expect(functions.length).toBeGreaterThanOrEqual(1);
      expect(functions.find(f => f.name === 'multiply')).toBeDefined();

      const imports = items.filter(i => i.kind === 'import');
      expect(imports.length).toBeGreaterThanOrEqual(1);
    });

    it('should throw for unsupported language', async () => {
      await expect(parseFileStructure('code', 'cobol')).rejects.toThrow('No query definitions');
    });

    it('should provide correct line numbers', async () => {
      const source = `// line 1
// line 2
function foo() {} // line 3
// line 4
class Bar {} // line 5
`;
      const items = await parseFileStructure(source, 'typescript');

      const foo = items.find(i => i.name === 'foo');
      expect(foo?.line).toBe(3);

      const bar = items.find(i => i.name === 'Bar');
      expect(bar?.line).toBe(5);
    });
  });

  describe('getSupportedLanguages', () => {
    it('should return at least typescript and python', () => {
      const languages = getSupportedLanguages();
      expect(languages).toContain('typescript');
      expect(languages).toContain('python');
      expect(languages).toContain('javascript');
    });
  });

  describe('getLanguageForExtension', () => {
    it('should map TypeScript extensions', () => {
      expect(getLanguageForExtension('.ts')).toBe('typescript');
      expect(getLanguageForExtension('.tsx')).toBe('tsx');
    });

    it('should map JavaScript extensions', () => {
      expect(getLanguageForExtension('.js')).toBe('javascript');
      expect(getLanguageForExtension('.jsx')).toBe('javascript');
      expect(getLanguageForExtension('.mjs')).toBe('javascript');
    });

    it('should map Python extension', () => {
      expect(getLanguageForExtension('.py')).toBe('python');
    });

    it('should return null for unsupported extensions', () => {
      expect(getLanguageForExtension('.yaml')).toBeNull();
      expect(getLanguageForExtension('.md')).toBeNull();
      expect(getLanguageForExtension('.txt')).toBeNull();
    });
  });
});
