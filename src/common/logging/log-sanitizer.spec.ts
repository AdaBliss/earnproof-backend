import { sanitizeLog, sanitizeObject } from './log-sanitizer';

describe('LogSanitizer', () => {
  describe('sanitizeLog', () => {
    it('should pass through safe strings', () => {
      const input = 'This is a safe log message';
      const result = sanitizeLog(input);
      expect(result.isSafe).toBe(true);
      expect(result.charsEscaped).toBe(0);
    });

    it('should escape newlines', () => {
      const input = 'Line 1\nLine 2';
      const result = sanitizeLog(input);
      expect(result.sanitized).toContain('\\n');
      expect(result.isSafe).toBe(false);
    });

    it('should escape carriage returns', () => {
      const input = 'Line 1\rLine 2';
      const result = sanitizeLog(input);
      expect(result.sanitized).toContain('\\r');
    });

    it('should escape ANSI escape sequences', () => {
      const input = 'Text\x1b[31mRed\x1b[0m';
      const result = sanitizeLog(input);
      expect(result.sanitized).toContain('\\x1b');
    });

    it('should escape tab characters', () => {
      const input = 'Column1\tColumn2';
      const result = sanitizeLog(input);
      expect(result.sanitized).toContain('\\t');
    });

    it('should escape NUL bytes', () => {
      const input = 'Before\x00After';
      const result = sanitizeLog(input);
      expect(result.sanitized).toContain('\\0');
    });

    it('should escape Unicode separators', () => {
      const input = 'Line1\u2028Line2';
      const result = sanitizeLog(input);
      expect(result.sanitized).toContain('\\u2028');
    });

    it('should escape bidi override characters', () => {
      const input = 'Normal\u202eReverse';
      const result = sanitizeLog(input);
      expect(result.sanitized).toContain('\\u202e');
    });

    it('should escape zero-width characters', () => {
      const input = 'Zero\u200bWidth';
      const result = sanitizeLog(input);
      expect(result.sanitized).toContain('\\u200b');
    });

    it('should escape backslashes', () => {
      const input = 'Path\\to\\file';
      const result = sanitizeLog(input);
      const matches = result.sanitized.match(/\\\\/g);
      expect(matches?.length).toBeGreaterThan(0);
    });
  });

  describe('log injection prevention', () => {
    it('should prevent newline injection to forge log lines', () => {
      const malicious = 'User: admin\n{"level":"error","msg":"hacked"}';
      const result = sanitizeLog(malicious);
      expect(result.sanitized).not.toContain('\n');
    });

    it('should prevent CRLF injection', () => {
      const malicious = 'Message\r\nFake log line';
      const result = sanitizeLog(malicious);
      expect(result.sanitized).not.toContain('\r');
      expect(result.sanitized).not.toContain('\n');
    });
  });

  describe('sanitizeObject', () => {
    it('should sanitize nested strings', () => {
      const obj = { message: 'Line1\nLine2', code: 'OK' };
      const result = sanitizeObject(obj);
      expect(result.message).toContain('\\n');
      expect(result.code).toBe('OK');
    });

    it('should sanitize Error objects', () => {
      const error = new Error('Error\nMessage');
      const result = sanitizeObject(error);
      expect(result.message).toContain('\\n');
    });

    it('should sanitize object keys', () => {
      const obj = { 'key\nname': 'value' };
      const result = sanitizeObject(obj);
      const keys = Object.keys(result);
      expect(keys[0]).toContain('\\n');
    });

    it('should handle max depth', () => {
      const deepObj = { a: { b: { c: { d: { e: 'value' } } } } };
      const result = sanitizeObject(deepObj, 0, 2);
      expect(JSON.stringify(result)).toContain('MAX_DEPTH');
    });
  });

  describe('determinism', () => {
    it('should always produce same output for same input', () => {
      const input = 'Test\nInput\x1b[31m';
      const result1 = sanitizeLog(input);
      const result2 = sanitizeLog(input);
      expect(result1.sanitized).toBe(result2.sanitized);
    });
  });
});
