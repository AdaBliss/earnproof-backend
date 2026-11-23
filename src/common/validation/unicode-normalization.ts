export enum NormalizationProfile {
  DISPLAY_LABEL = 'DISPLAY_LABEL',
  COMPARISON_KEY = 'COMPARISON_KEY',
  SLUG_OR_HANDLE = 'SLUG_OR_HANDLE',
}

export interface NormalizationResult {
  displayValue: string;
  comparisonKey: string;
  normalized: boolean;
}

const MAX_LENGTH_BYTES = {
  [NormalizationProfile.DISPLAY_LABEL]: 255,
  [NormalizationProfile.COMPARISON_KEY]: 255,
  [NormalizationProfile.SLUG_OR_HANDLE]: 50,
};

export function normalize(
  input: string,
  profile: NormalizationProfile
): NormalizationResult {
  if (!input) {
    throw new Error('Input cannot be empty');
  }

  // Check max length BEFORE normalization
  const inputBytes = Buffer.byteLength(input, 'utf8');
  if (inputBytes > MAX_LENGTH_BYTES[profile]) {
    throw new Error(`Input exceeds max length of ${MAX_LENGTH_BYTES[profile]} bytes`);
  }

  // Reject invalid Unicode
  validateUnicode(input);

  // Preserve original for display (NFC)
  const displayValue = input.normalize('NFC');

  // Compute canonical key
  let comparisonKey: string;

  if (profile === NormalizationProfile.SLUG_OR_HANDLE) {
    // NFKC + lowercase + alphanumeric + hyphen/underscore only
    comparisonKey = input
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\w-]/g, '')
      .trim();

    if (!comparisonKey) {
      throw new Error('Handle produces empty string after normalization');
    }
  } else if (profile === NormalizationProfile.COMPARISON_KEY) {
    // NFKC + lowercase + collapse whitespace
    comparisonKey = input
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    // DISPLAY_LABEL: NFC only
    comparisonKey = displayValue;
  }

  const normalized = displayValue !== comparisonKey;

  return { displayValue, comparisonKey, normalized };
}

function validateUnicode(input: string): void {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const nextCode = i + 1 < input.length ? input.charCodeAt(i + 1) : null;

    // Reject lone surrogates
    if (code >= 0xd800 && code <= 0xdbff && (!nextCode || nextCode < 0xdc00 || nextCode > 0xdfff)) {
      throw new Error('Invalid Unicode: lone surrogate');
    }

    // Reject C0 controls (except whitespace)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      throw new Error(`Invalid Unicode: control character U+${code.toString(16).padStart(4, '0')}`);
    }

    // Reject bidi override/isolate
    if (code === 0x202e || code === 0x202d || code === 0x2066 || code === 0x2067) {
      throw new Error('Invalid Unicode: bidi override or isolate character');
    }

    // Reject zero-width joiner/non-joiner in sensitive contexts
    if (code === 0x200d || code === 0x200c) {
      throw new Error('Invalid Unicode: zero-width connector');
    }
  }
}
