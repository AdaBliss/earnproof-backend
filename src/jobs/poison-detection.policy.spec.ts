import { classifyJobError, ErrorClassification } from './poison-detection.policy';

describe('PoisonDetectionPolicy', () => {
  describe('transient errors', () => {
    it('should classify timeout as TRANSIENT', () => {
      const result = classifyJobError(new Error('Request timeout'));
      expect(result.classification).toBe('TRANSIENT');
    });

    it('should classify ECONNREFUSED as TRANSIENT', () => {
      const result = classifyJobError({ code: 'ECONNREFUSED', message: 'Connection refused' });
      expect(result.classification).toBe('TRANSIENT');
    });

    it('should classify rate limit 429 as TRANSIENT', () => {
      const result = classifyJobError(new Error('429: Too many requests'));
      expect(result.classification).toBe('TRANSIENT');
    });
  });

  describe('permanent errors', () => {
    it('should classify 401 unauthorized as PERMANENT', () => {
      const result = classifyJobError(new Error('401 Unauthorized'));
      expect(result.classification).toBe('PERMANENT');
    });

    it('should classify 403 forbidden as PERMANENT', () => {
      const result = classifyJobError(new Error('403 Forbidden'));
      expect(result.classification).toBe('PERMANENT');
    });

    it('should classify duplicate as PERMANENT', () => {
      const result = classifyJobError(new Error('Duplicate entry already exists'));
      expect(result.classification).toBe('PERMANENT');
    });

    it('should classify invalid input as PERMANENT', () => {
      const result = classifyJobError(new Error('Invalid input: malformed commitment'));
      expect(result.classification).toBe('PERMANENT');
    });
  });

  describe('unknown errors', () => {
    it('should classify unmatched error as UNKNOWN', () => {
      const result = classifyJobError(new Error('Some random error'));
      expect(result.classification).toBe('UNKNOWN');
    });

    it('should classify null as UNKNOWN', () => {
      const result = classifyJobError(null);
      expect(result.classification).toBe('UNKNOWN');
    });

    it('should classify undefined as UNKNOWN', () => {
      const result = classifyJobError(undefined);
      expect(result.classification).toBe('UNKNOWN');
    });
  });

  describe('determinism', () => {
    it('should always return same classification for same error', () => {
      const error = new Error('Connection timeout');
      const result1 = classifyJobError(error);
      const result2 = classifyJobError(error);
      expect(result1.classification).toBe(result2.classification);
    });
  });
});
