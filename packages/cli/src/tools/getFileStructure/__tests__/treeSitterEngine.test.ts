import { describe, it, expect } from 'vitest';
import { parseFileStructure, getSupportedLanguages, getLanguageForExtension, stripComments } from '../treeSitterEngine';

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

  describe('stripComments', () => {
    it('removes line and block comments from TypeScript while keeping code intact', async () => {
      const source = `// leading comment
import { useState } from 'react'; // trailing comment

/* block comment
   spanning lines */
export function greet(name: string): string {
  // inner comment
  return \`Hello, \${name}\`; /* inline block */
}
`;
      const stripped = await stripComments(source, '.ts');
      expect(stripped).not.toBeNull();
      expect(stripped).not.toContain('leading comment');
      expect(stripped).not.toContain('block comment');
      expect(stripped).not.toContain('inner comment');
      expect(stripped).not.toContain('inline block');
      // Code retained
      expect(stripped).toContain("import { useState } from 'react';");
      expect(stripped).toContain('export function greet(name: string): string');
      expect(stripped).toContain('return `Hello, ${name}`;');

      // Stripped output is still syntactically valid: re-parsing finds the same symbols.
      const items = await parseFileStructure(stripped as string, 'typescript');
      expect(items.find(i => i.kind === 'function' && i.name === 'greet')).toBeDefined();
    });

    it('removes JSX comments from TSX', async () => {
      const source = `export const App = () => {
  return (
    <div>
      {/* jsx comment here */}
      <span>hello</span>
    </div>
  );
};
`;
      const stripped = await stripComments(source, '.tsx');
      expect(stripped).not.toBeNull();
      expect(stripped).not.toContain('jsx comment here');
      expect(stripped).toContain('<span>hello</span>');
    });

    it('strips Python # comments but preserves docstrings', async () => {
      const source = `# module comment
def add(a, b):
    """Return the sum of a and b."""  # trailing comment
    return a + b  # inline
`;
      const stripped = await stripComments(source, '.py');
      expect(stripped).not.toBeNull();
      expect(stripped).not.toContain('module comment');
      expect(stripped).not.toContain('trailing comment');
      expect(stripped).not.toContain('# inline');
      // Docstring is a string expression (semantically live via __doc__), not a comment.
      expect(stripped).toContain('"""Return the sum of a and b."""');
      expect(stripped).toContain('return a + b');
    });

    it('returns the source unchanged when there are no comments', async () => {
      const source = `export const x = 1;\nexport const y = 2;\n`;
      const stripped = await stripComments(source, '.ts');
      expect(stripped).toBe(source);
    });

    it('returns null for unsupported extensions (caller falls back)', async () => {
      expect(await stripComments('key: value', '.yaml')).toBeNull();
      expect(await stripComments('# title', '.md')).toBeNull();
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
