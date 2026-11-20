// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { stripComments } from '../../scripts/apiKeyScopeRoutes';

/**
 * Invariant: the ledger is written only through CreditTransactionRepository.createTransaction, which
 * stamps the connected app and payer standing. A second writer would leave unattributed rows that the
 * per-app usage queries silently miss.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
// 'packages' includes packages/premium, where private overlays are checked out.
const ROOTS = ['apps', 'packages', 'b4m-core', 'infra'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.sst', '.turbo', 'coverage', 'build']);
const REPOSITORY_FILE = path.join('packages', 'database', 'src', 'models', 'billing', 'CreditTransactionModel.ts');

const MODEL_WRITE =
  /\bCreditTransaction(?:Model)?\s*\.\s*(?:create|insertMany|insertOne|bulkWrite|collection\s*\.\s*(?:insertOne|insertMany|bulkWrite|replaceOne))\b|\bcreditTransactionRepository\s*\.\s*create\s*\(/;
const MODEL_CONSTRUCT = /\bnew\s+CreditTransaction(?:Model)?\s*\(/;
const RAW_COLLECTION = /collection\s*(?:<[^>]*>)?\s*\(\s*['"`]credittransactions['"`]\s*\)/;
const RAW_INSERT = /\.\s*(?:insertOne|insertMany|bulkWrite|replaceOne)\s*\(/;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(full);
    return /\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });

const writesLedger = (source: string): boolean =>
  MODEL_WRITE.test(source) || MODEL_CONSTRUCT.test(source) || (RAW_COLLECTION.test(source) && RAW_INSERT.test(source));

describe('credit ledger writers', () => {
  it('inserts CreditTransaction rows only through createTransaction', () => {
    const offenders = ROOTS.flatMap(root => {
      try {
        return sourceFiles(path.join(REPO_ROOT, root));
      } catch {
        return [];
      }
    })
      .map(file => path.relative(REPO_ROOT, file))
      .filter(file => file !== REPOSITORY_FILE)
      .filter(file => writesLedger(stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('flags each write shape', () => {
    expect(writesLedger('await CreditTransaction.create({})')).toBe(true);
    expect(writesLedger('await CreditTransaction.insertMany(rows)')).toBe(true);
    expect(writesLedger('new CreditTransactionModel({})')).toBe(true);
    expect(writesLedger('await CreditTransaction.collection.insertOne(row)')).toBe(true);
    expect(writesLedger('await CreditTransaction.collection.find({})')).toBe(false);
    expect(writesLedger("db.collection('credittransactions').insertOne(row)")).toBe(true);
    expect(writesLedger('await creditTransactionRepository.create({})')).toBe(true);
    expect(writesLedger('await creditTransactionRepository\n  .create(row)')).toBe(true);
    expect(writesLedger('await creditTransactionRepository.createTransaction(t, d)')).toBe(false);
  });
});
