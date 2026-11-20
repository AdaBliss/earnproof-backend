export interface ConfusableResult {
  hasMixedScript: boolean;
  confusableSkeleton: string;
}

const SCRIPT_BOUNDARIES = {
  LATIN: /[a-zA-Z]/,
  CYRILLIC: /[\u0400-\u04FF]/,
  GREEK: /[\u0370-\u03FF]/,
  CJK: /[\u4E00-\u9FFF\u3040-\u309F\uAC00-\uD7AF]/,
};

const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic → Latin
  '\u0430': 'a', // а → a
  '\u043E': 'o', // о → o
  '\u0435': 'e', // е → e
  '\u043F': 'p', // п → p
  '\u0445': 'x', // х → x
  '\u0441': 'c', // с → c
  '\u043C': 'm', // м → m
  '\u0439': 'y', // й → y
  '\u0443': 'y', // у → y
  // Greek → Latin
  '\u03B1': 'a', // α → a
  '\u03BF': 'o', // ο → o
  '\u03C1': 'p', // ρ → p
  '\u03BD': 'v', // ν → v
  '\u03C2': 's', // ς → s
  '\u03C4': 't', // τ → t
};

export function detectConfusables(value: string): ConfusableResult {
  const normalized = value.normalize('NFKC').toLowerCase();

  // Check for mixed scripts
  const hasLatin = SCRIPT_BOUNDARIES.LATIN.test(normalized);
  const hasCyrillic = SCRIPT_BOUNDARIES.CYRILLIC.test(normalized);
  const hasGreek = SCRIPT_BOUNDARIES.GREEK.test(normalized);
  const hasCJK = SCRIPT_BOUNDARIES.CJK.test(normalized);

  const scriptCount = [hasLatin, hasCyrillic, hasGreek, hasCJK].filter(Boolean).length;
  const hasMixedScript = scriptCount > 1;

  // Generate confusable skeleton
  let skeleton = '';
  for (const char of normalized) {
    skeleton += HOMOGLYPHS[char] || char;
  }

  return {
    hasMixedScript,
    confusableSkeleton: skeleton,
  };
}

export function checkConfusableCollision(newValue: string, existingValues: string[]): boolean {
  const newSkeleton = detectConfusables(newValue).confusableSkeleton;

  for (const existing of existingValues) {
    const existingSkeleton = detectConfusables(existing).confusableSkeleton;
    if (newSkeleton === existingSkeleton) {
      return true;
    }
  }

  return false;
}
