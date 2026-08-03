import { describe, it, expect } from 'vitest';
import { foldTagName, isDataLakeTagName, normalizeTagName } from './tagName';

describe('tagName', () => {
  describe('normalizeTagName', () => {
    it('trims surrounding whitespace', () => {
      expect(normalizeTagName('  invoices  ')).toBe('invoices');
    });

    // Tag documents keep the casing they were created with, and a rename writes what the caller
    // typed. Lowercasing here would silently rewrite every renamed tag.
    it('preserves casing', () => {
      expect(normalizeTagName('Invoices')).toBe('Invoices');
      expect(normalizeTagName('INVOICES')).toBe('INVOICES');
    });
  });

  describe('foldTagName', () => {
    it('folds casing so two spellings of one tag compare equal', () => {
      expect(foldTagName('Invoices')).toBe(foldTagName('invoices'));
      expect(foldTagName('INVOICES')).toBe(foldTagName('invoices'));
    });

    it('trims before folding, so a padded name still collides', () => {
      expect(foldTagName('  Invoices ')).toBe(foldTagName('invoices'));
    });

    it('keeps genuinely different names distinct', () => {
      expect(foldTagName('invoices')).not.toBe(foldTagName('invoices-2024'));
    });

    // The fold must agree with listFileTags (which folds unclaimed aggregate buckets onto tag
    // documents) and with the chip match in ItemActions. toLocaleLowerCase's dotless-i mapping
    // varies by runtime locale, so a Turkish-locale server would fold `I` to a different
    // codepoint than the browser and the two would stop agreeing on what one tag is.
    it('uses locale-independent folding', () => {
      expect(foldTagName('INVOICES')).toBe('invoices');
      expect(foldTagName('I')).toBe('i');
    });
  });

  describe('isDataLakeTagName', () => {
    it('recognizes a membership tag', () => {
      expect(isDataLakeTagName('datalake:acme')).toBe(true);
    });

    // The guard must fold, because the writes it gates match names case-insensitively. A
    // case-sensitive guard would pass `DATALAKE:acme` through and then strip the real
    // `datalake:acme` membership off every file the caller owns.
    it('recognizes casing variants, which a case-sensitive check would let through', () => {
      expect(isDataLakeTagName('DATALAKE:acme')).toBe(true);
      expect(isDataLakeTagName('DataLake:acme')).toBe(true);
      expect(isDataLakeTagName('dAtAlAkE:acme')).toBe(true);
    });

    it('sees through surrounding whitespace', () => {
      expect(isDataLakeTagName('  datalake:acme  ')).toBe(true);
      expect(isDataLakeTagName('\tDATALAKE:acme')).toBe(true);
    });

    it('leaves ordinary tags alone, including one that merely mentions the word', () => {
      expect(isDataLakeTagName('invoices')).toBe(false);
      expect(isDataLakeTagName('my-datalake:acme')).toBe(false);
      expect(isDataLakeTagName('datalake')).toBe(false);
    });
  });
});
