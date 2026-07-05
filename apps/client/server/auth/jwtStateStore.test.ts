import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

let mockJwtSecret: string | undefined = 'test-jwt-secret-for-state-store';

// Mock Config with getter to allow dynamic values
vi.mock('@server/utils/config', () => ({
  Config: {
    get JWT_SECRET() {
      return mockJwtSecret;
    },
  },
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks are set up
import { createStateToken, verifyStateToken, validateJwtSecret, BaseStatePayload } from './jwtStateStore';

describe('jwtStateStore', () => {
  const TEST_AUDIENCE = 'test-oauth-state';

  beforeEach(() => {
    vi.clearAllMocks();
    mockJwtSecret = 'test-jwt-secret-for-state-store';
  });

  describe('validateJwtSecret', () => {
    it('should return secret when JWT_SECRET is configured', () => {
      const secret = validateJwtSecret();
      expect(secret).toBe('test-jwt-secret-for-state-store');
    });

    it('should throw error when JWT_SECRET is not configured', () => {
      mockJwtSecret = undefined;
      expect(() => validateJwtSecret()).toThrow('Missing JWT_SECRET configuration for OAuth state signing');
    });

    it('should throw error when JWT_SECRET is empty string', () => {
      mockJwtSecret = '';
      expect(() => validateJwtSecret()).toThrow('Missing JWT_SECRET configuration for OAuth state signing');
    });
  });

  describe('createStateToken', () => {
    it('should create a valid JWT with required claims', () => {
      const token = createStateToken({ audience: TEST_AUDIENCE });

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');

      const decoded = jwt.verify(token, 'test-jwt-secret-for-state-store') as BaseStatePayload;
      expect(decoded.handle).toBeDefined();
      expect(decoded.handle).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(decoded.createdAt).toBeDefined();
      expect(typeof decoded.createdAt).toBe('number');
      expect(decoded.aud).toBe(TEST_AUDIENCE);
      expect(decoded.iss).toBe('bike4mind');
    });

    it('should include additional payload data', () => {
      const additionalData = { customField: 'customValue', nested: { data: 123 } };
      const token = createStateToken({ audience: TEST_AUDIENCE }, additionalData);

      const decoded = jwt.verify(token, 'test-jwt-secret-for-state-store') as BaseStatePayload & typeof additionalData;
      expect(decoded.customField).toBe('customValue');
      expect(decoded.nested).toEqual({ data: 123 });
    });

    it('should use custom expiration time', () => {
      const token = createStateToken({ audience: TEST_AUDIENCE, expiresIn: '1h' });

      const decoded = jwt.decode(token) as { exp: number; iat: number };
      const expirationDiff = decoded.exp - decoded.iat;
      expect(expirationDiff).toBe(3600); // 1 hour in seconds
    });

    it('should use default 5 minute expiration', () => {
      const token = createStateToken({ audience: TEST_AUDIENCE });

      const decoded = jwt.decode(token) as { exp: number; iat: number };
      const expirationDiff = decoded.exp - decoded.iat;
      expect(expirationDiff).toBe(300); // 5 minutes in seconds
    });

    it('should throw when JWT_SECRET is not configured', () => {
      mockJwtSecret = undefined;
      expect(() => createStateToken({ audience: TEST_AUDIENCE })).toThrow(
        'Missing JWT_SECRET configuration for OAuth state signing'
      );
    });
  });

  describe('verifyStateToken', () => {
    it('should verify valid token and return payload', () => {
      const token = createStateToken({ audience: TEST_AUDIENCE });
      const result = verifyStateToken<BaseStatePayload>(token, { audience: TEST_AUDIENCE });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.payload.handle).toBeDefined();
        expect(result.payload.aud).toBe(TEST_AUDIENCE);
        expect(result.payload.iss).toBe('bike4mind');
      }
    });

    it('should return missing reason for empty token', () => {
      const result = verifyStateToken('', { audience: TEST_AUDIENCE });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('missing');
        expect(result.message).toBe('Missing state parameter');
      }
    });

    it('should return expired reason for expired token', () => {
      const expiredToken = jwt.sign(
        { handle: 'test', createdAt: Date.now(), aud: TEST_AUDIENCE, iss: 'bike4mind' },
        'test-jwt-secret-for-state-store',
        { expiresIn: '-1s', algorithm: 'HS256' }
      );

      const result = verifyStateToken(expiredToken, { audience: TEST_AUDIENCE });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('expired');
        expect(result.message).toBe('Authorization request expired. Please try again.');
      }
    });

    it('should return invalid reason for tampered token', () => {
      const tamperedToken = jwt.sign(
        { handle: 'test', createdAt: Date.now(), aud: TEST_AUDIENCE, iss: 'bike4mind' },
        'wrong-secret',
        { expiresIn: '5m', algorithm: 'HS256' }
      );

      const result = verifyStateToken(tamperedToken, { audience: TEST_AUDIENCE });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('invalid');
        expect(result.message).toBe('Invalid authorization state.');
      }
    });

    it('should reject token with wrong audience', () => {
      const wrongAudienceToken = jwt.sign(
        { handle: 'test', createdAt: Date.now(), aud: 'wrong-audience', iss: 'bike4mind' },
        'test-jwt-secret-for-state-store',
        { expiresIn: '5m', algorithm: 'HS256' }
      );

      const result = verifyStateToken(wrongAudienceToken, { audience: TEST_AUDIENCE });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('invalid');
      }
    });

    it('should reject token with wrong issuer', () => {
      const wrongIssuerToken = jwt.sign(
        { handle: 'test', createdAt: Date.now(), aud: TEST_AUDIENCE, iss: 'wrong-issuer' },
        'test-jwt-secret-for-state-store',
        { expiresIn: '5m', algorithm: 'HS256' }
      );

      const result = verifyStateToken(wrongIssuerToken, { audience: TEST_AUDIENCE });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('invalid');
      }
    });

    it('should reject alg:none attack', () => {
      const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          handle: 'test',
          createdAt: Date.now(),
          aud: TEST_AUDIENCE,
          iss: 'bike4mind',
        })
      ).toString('base64url');
      const noneAlgToken = `${header}.${payload}.`;

      const result = verifyStateToken(noneAlgToken, { audience: TEST_AUDIENCE });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('invalid');
      }
    });

    it('should reject wrong algorithm (HS384)', () => {
      const wrongAlgToken = jwt.sign(
        { handle: 'test', createdAt: Date.now(), aud: TEST_AUDIENCE, iss: 'bike4mind' },
        'test-jwt-secret-for-state-store',
        { expiresIn: '5m', algorithm: 'HS384' }
      );

      const result = verifyStateToken(wrongAlgToken, { audience: TEST_AUDIENCE });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('invalid');
      }
    });

    it('should reject malformed token', () => {
      const result = verifyStateToken('not-a-valid-jwt', { audience: TEST_AUDIENCE });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe('invalid');
      }
    });
  });
});
