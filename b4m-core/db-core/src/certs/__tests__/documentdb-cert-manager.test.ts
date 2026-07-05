import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isDocumentDBConnection, addCertificateToUri } from '../documentdb-cert-manager';

describe('DocumentDB Certificate Manager', () => {
  describe('isDocumentDBConnection', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should detect DocumentDB when MAIN_DB_TYPE is set', () => {
      process.env.MAIN_DB_TYPE = 'DocumentDB';
      expect(isDocumentDBConnection('mongodb://any-uri')).toBe(true);
    });

    it('should not detect DocumentDB when MAIN_DB_TYPE is MongoAtlas', () => {
      process.env.MAIN_DB_TYPE = 'MongoAtlas';
      expect(isDocumentDBConnection('mongodb://any-uri')).toBe(false);
    });

    it('should auto-detect DocumentDB URLs with docdb in hostname', () => {
      const uri = 'mongodb://user:pass@docdb-cluster.cluster-123.us-east-1.docdb.amazonaws.com:27017/db';
      expect(isDocumentDBConnection(uri)).toBe(true);
    });

    it('should auto-detect DocumentDB URLs with documentdb in hostname', () => {
      const uri = 'mongodb://user:pass@documentdb-cluster.cluster-123.us-east-1.documentdb.amazonaws.com:27017/db';
      expect(isDocumentDBConnection(uri)).toBe(true);
    });

    it('should auto-detect DocumentDB URLs with rds.amazonaws.com', () => {
      const uri = 'mongodb://user:pass@cluster.cluster-123.us-east-1.rds.amazonaws.com:27017/db';
      expect(isDocumentDBConnection(uri)).toBe(true);
    });

    it('should not detect MongoDB Atlas URLs', () => {
      const uri = 'mongodb+srv://user:pass@cluster.abc123.mongodb.net/db';
      expect(isDocumentDBConnection(uri)).toBe(false);
    });

    it('should handle invalid URLs gracefully', () => {
      expect(isDocumentDBConnection('invalid-url')).toBe(false);
    });
  });

  describe('addCertificateToUri', () => {
    it('should add certificate to URI without query parameters', () => {
      const uri = 'mongodb://localhost:27017/db';
      const certPath = '/tmp/cert.pem';
      const result = addCertificateToUri(uri, certPath);
      expect(result).toBe(
        'mongodb://localhost:27017/db?tls=true&tlsCAFile=/tmp/cert.pem&authMechanism=SCRAM-SHA-1&authSource=admin&retryWrites=false'
      );
    });

    it('should add certificate to URI with existing query parameters', () => {
      const uri = 'mongodb://localhost:27017/db?retryWrites=false';
      const certPath = '/tmp/cert.pem';
      const result = addCertificateToUri(uri, certPath);
      expect(result).toBe(
        'mongodb://localhost:27017/db?retryWrites=false&tls=true&tlsCAFile=/tmp/cert.pem&authMechanism=SCRAM-SHA-1&authSource=admin'
      );
    });

    it('should not duplicate existing parameters', () => {
      const uri = 'mongodb://localhost:27017/db?authMechanism=SCRAM-SHA-1&authSource=admin';
      const certPath = '/tmp/cert.pem';
      const result = addCertificateToUri(uri, certPath);
      expect(result).toBe(
        'mongodb://localhost:27017/db?authMechanism=SCRAM-SHA-1&authSource=admin&tls=true&tlsCAFile=/tmp/cert.pem&retryWrites=false'
      );
    });

    it('should not modify URI that already has tlsCAFile', () => {
      const uri = 'mongodb://localhost:27017/db?tlsCAFile=/existing/path.pem';
      const certPath = '/tmp/cert.pem';
      const result = addCertificateToUri(uri, certPath);
      expect(result).toBe(uri);
    });

    it('should handle complex URIs with credentials', () => {
      const uri = 'mongodb://user:pass@cluster.docdb.amazonaws.com:27017/mydb';
      const certPath = '/tmp/cert.pem';
      const result = addCertificateToUri(uri, certPath);
      expect(result).toBe(
        'mongodb://user:pass@cluster.docdb.amazonaws.com:27017/mydb?tls=true&tlsCAFile=/tmp/cert.pem&authMechanism=SCRAM-SHA-1&authSource=admin&retryWrites=false'
      );
    });
  });
});
