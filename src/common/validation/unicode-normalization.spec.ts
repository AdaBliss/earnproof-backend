import { normalize, NormalizationProfile } from './unicode-normalization';

describe('UnicodeNormalization', () => {
  describe('DISPLAY_LABEL profile', () => {
    it('should preserve ASCII unchanged', () => {
      const result = normalize('HelloWorld', NormalizationProfile.DISPLAY_LABEL);
      expect(result.displayValue).toBe('HelloWorld');
    });

    it('should normalize NFC and NFD to same key', () => {
      const nfc = 'café'; // NFC form
      const nfd = 'café'; // NFD form (composed differently)
      
      const resultNfc = normalize(nfc, NormalizationProfile.DISPLAY_LABEL);
      const resultNfd = normalize(nfd, NormalizationProfile.DISPLAY_LABEL);
      
      expect(resultNfc.comparisonKey).toBe(resultNfd.comparisonKey);
    });

    it('should preserve original for display', () => {
      const input = 'My Organization';
      const result = normalize(input, NormalizationProfile.DISPLAY_LABEL);
      expect(result.displayValue).toBe(input);
    });
  });

  describe('COMPARISON_KEY profile', () => {
    it('should lowercase and normalize', () => {
      const result = normalize('HelloWorld', NormalizationProfile.COMPARISON_KEY);
      expect(result.comparisonKey).toBe('helloworld');
    });

    it('should collapse whitespace', () => {
      const result = normalize('Hello   World', NormalizationProfile.COMPARISON_KEY);
      expect(result.comparisonKey).toBe('hello world');
    });
  });

  describe('SLUG_OR_HANDLE profile', () => {
    it('should lowercase and remove special chars', () => {
      const result = normalize('My-Handle', NormalizationProfile.SLUG_OR_HANDLE);
      expect(result.comparisonKey).toBe('my-handle');
    });

    it('should allow hyphens and underscores', () => {
      const result = normalize('my_handle-123', NormalizationProfile.SLUG_OR_HANDLE);
      expect(result.comparisonKey).toBe('my_handle-123');
    });
  });

  describe('validation', () => {
    it('should reject empty input', () => {
      expect(() => normalize('', NormalizationProfile.DISPLAY_LABEL)).toThrow();
    });

    it('should reject input exceeding max length', () => {
      const longString = 'a'.repeat(300);
      expect(() => normalize(longString, NormalizationProfile.DISPLAY_LABEL)).toThrow();
    });

    it('should reject control characters', () => {
      const input = 'Hello\x00World';
      expect(() => normalize(input, NormalizationProfile.DISPLAY_LABEL)).toThrow();
    });

    it('should reject bidi override characters', () => {
      const input = 'Hello\u202eWorld';
      expect(() => normalize(input, NormalizationProfile.DISPLAY_LABEL)).toThrow();
    });

    it('should reject zero-width characters', () => {
      const input = 'Hello\u200bWorld';
      expect(() => normalize(input, NormalizationProfile.DISPLAY_LABEL)).toThrow();
    });
  });

  describe('determinism', () => {
    it('should always return same result for same input', () => {
      const input = 'Test Input';
      const result1 = normalize(input, NormalizationProfile.COMPARISON_KEY);
      const result2 = normalize(input, NormalizationProfile.COMPARISON_KEY);
      expect(result1.comparisonKey).toBe(result2.comparisonKey);
    });
  });
});
