import { computeCacheHeaders, buildVaryHeader } from './cache-policy';
import { RouteClassification } from './route-classification';

describe('CachePolicy', () => {
  describe('computeCacheHeaders', () => {
    it('should return no-store for SENSITIVE classification', () => {
      const headers = computeCacheHeaders(RouteClassification.SENSITIVE, 'GET', 200);
      expect(headers['Cache-Control']).toContain('no-store');
    });

    it('should return no-store for AUTHENTICATED classification', () => {
      const headers = computeCacheHeaders(RouteClassification.AUTHENTICATED, 'GET', 200);
      expect(headers['Cache-Control']).toContain('no-store');
    });

    it('should return public max-age for PUBLIC_STATIC classification', () => {
      const headers = computeCacheHeaders(RouteClassification.PUBLIC_STATIC, 'GET', 200);
      expect(headers['Cache-Control']).toContain('public');
      expect(headers['Cache-Control']).toContain('max-age=3600');
    });

    it('should return no-store for error responses', () => {
      const headers = computeCacheHeaders(RouteClassification.PUBLIC_STATIC, 'GET', 401);
      expect(headers['Cache-Control']).toContain('no-store');
    });

    it('should return no-store for non-safe methods', () => {
      const headers = computeCacheHeaders(RouteClassification.PUBLIC_STATIC, 'POST', 200);
      expect(headers['Cache-Control']).toContain('no-store');
    });

    it('should include Pragma: no-cache for SENSITIVE', () => {
      const headers = computeCacheHeaders(RouteClassification.SENSITIVE, 'GET', 200);
      expect(headers['Pragma']).toBe('no-cache');
    });
  });

  describe('buildVaryHeader', () => {
    it('should include Authorization by default', () => {
      const vary = buildVaryHeader();
      expect(vary).toContain('Authorization');
    });

    it('should include Cookie by default', () => {
      const vary = buildVaryHeader();
      expect(vary).toContain('Cookie');
    });

    it('should merge with existing Vary', () => {
      const vary = buildVaryHeader('Accept');
      expect(vary).toContain('Accept');
      expect(vary).toContain('Authorization');
    });

    it('should deduplicate Vary values', () => {
      const vary = buildVaryHeader('Authorization, Accept');
      const parts = vary.split(',').map(v => v.trim());
      const uniqueParts = new Set(parts);
      expect(parts.length).toBe(uniqueParts.size);
    });

    it('should return stable order', () => {
      const vary1 = buildVaryHeader('Accept, Accept-Encoding');
      const vary2 = buildVaryHeader('Accept-Encoding, Accept');
      expect(vary1).toBe(vary2);
    });
  });
});
