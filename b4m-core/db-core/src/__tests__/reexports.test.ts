import { describe, it, expect } from 'vitest';

describe('db-core re-exports', () => {
  describe('BaseRepository', () => {
    it('exports BaseRepository as default', async () => {
      const mod = await import('../index.js');
      expect(mod.default).toBeDefined();
    });

    it('exports BaseRepository as named export', async () => {
      const { BaseRepository } = await import('../index.js');
      expect(BaseRepository).toBeDefined();
    });
  });

  describe('mongo utilities', () => {
    it('exports connectDB', async () => {
      const { connectDB } = await import('../index.js');
      expect(connectDB).toBeTypeOf('function');
    });

    it('exports getDB', async () => {
      const { getDB } = await import('../index.js');
      expect(getDB).toBeTypeOf('function');
    });

    it('exports withTransaction', async () => {
      const { withTransaction } = await import('../index.js');
      expect(withTransaction).toBeTypeOf('function');
    });

    it('exports isTransientTransactionError', async () => {
      const { isTransientTransactionError } = await import('../index.js');
      expect(isTransientTransactionError).toBeTypeOf('function');
    });

    it('exports softDeletePlugin', async () => {
      const { softDeletePlugin } = await import('../index.js');
      expect(softDeletePlugin).toBeTypeOf('function');
    });

    it('exports convertId', async () => {
      const { convertId } = await import('../index.js');
      expect(convertId).toBeTypeOf('function');
    });

    it('exports convertIds', async () => {
      const { convertIds } = await import('../index.js');
      expect(convertIds).toBeTypeOf('function');
    });

    it('exports compareMongoIds', async () => {
      const { compareMongoIds } = await import('../index.js');
      expect(compareMongoIds).toBeTypeOf('function');
    });

    it('exports mongoExportedRecordConverter', async () => {
      const { mongoExportedRecordConverter } = await import('../index.js');
      expect(mongoExportedRecordConverter).toBeTypeOf('function');
    });

    it('exports findModelByCollectionName', async () => {
      const { findModelByCollectionName } = await import('../index.js');
      expect(findModelByCollectionName).toBeTypeOf('function');
    });

    it('exports safeDropIndex', async () => {
      const { safeDropIndex } = await import('../index.js');
      expect(safeDropIndex).toBeTypeOf('function');
    });
  });

  describe('DocumentDB compat', () => {
    it('exports USE_DOCUMENTDB', async () => {
      const { USE_DOCUMENTDB } = await import('../index.js');
      expect(USE_DOCUMENTDB).toBeTypeOf('function');
    });

    it('exports executeFacetCompatible', async () => {
      const { executeFacetCompatible } = await import('../index.js');
      expect(executeFacetCompatible).toBeTypeOf('function');
    });

    it('exports createCompatibleLookup', async () => {
      const { createCompatibleLookup } = await import('../index.js');
      expect(createCompatibleLookup).toBeTypeOf('function');
    });

    it('exports convertPipelineForDocumentDB', async () => {
      const { convertPipelineForDocumentDB } = await import('../index.js');
      expect(convertPipelineForDocumentDB).toBeTypeOf('function');
    });

    it('exports convertLookupForDocumentDB', async () => {
      const { convertLookupForDocumentDB } = await import('../index.js');
      expect(convertLookupForDocumentDB).toBeTypeOf('function');
    });

    it('exports addLowercaseField', async () => {
      const { addLowercaseField } = await import('../index.js');
      expect(addLowercaseField).toBeTypeOf('function');
    });

    it('exports getCompatibleSort', async () => {
      const { getCompatibleSort } = await import('../index.js');
      expect(getCompatibleSort).toBeTypeOf('function');
    });
  });

  describe('cert manager', () => {
    it('exports getDocumentDBCertificate', async () => {
      const { getDocumentDBCertificate } = await import('../index.js');
      expect(getDocumentDBCertificate).toBeTypeOf('function');
    });

    it('exports isDocumentDBConnection', async () => {
      const { isDocumentDBConnection } = await import('../index.js');
      expect(isDocumentDBConnection).toBeTypeOf('function');
    });

    it('exports addCertificateToUri', async () => {
      const { addCertificateToUri } = await import('../index.js');
      expect(addCertificateToUri).toBeTypeOf('function');
    });
  });
});
