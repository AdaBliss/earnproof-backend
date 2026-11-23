export interface SanitizationResult {
  sanitized: string;
  isSafe: boolean;
  charsEscaped: number;
}

export function sanitizeLog(input: string): SanitizationResult {
  if (!input || typeof input !== 'string') {
    return { sanitized: String(input), isSafe: true, charsEscaped: 0 };
  }

  let output = '';
  let charsEscaped = 0;

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);

    // C0 controls (0x00-0x1F)
    if (code >= 0x00 && code <= 0x1f) {
      output += escapeChar(code);
      charsEscaped++;
      continue;
    }

    // DEL (0x7F)
    if (code === 0x7f) {
      output += '\\x7f';
      charsEscaped++;
      continue;
    }

    // C1 controls (0x80-0x9F)
    if (code >= 0x80 && code <= 0x9f) {
      output += `\\x${code.toString(16).padStart(2, '0')}`;
      charsEscaped++;
      continue;
    }

    // Unicode separators (U+2028, U+2029)
    if (code === 0x2028) {
      output += '\\u2028';
      charsEscaped++;
      continue;
    }
    if (code === 0x2029) {
      output += '\\u2029';
      charsEscaped++;
      continue;
    }

    // Bidi override/isolate (U+202E, U+202D, U+2066, U+2067, U+2068, U+2069)
    if ([0x202e, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069].includes(code)) {
      output += `\\u${code.toString(16).padStart(4, '0')}`;
      charsEscaped++;
      continue;
    }

    // Zero-width characters (U+200B, U+200C, U+200D, U+FEFF)
    if ([0x200b, 0x200c, 0x200d, 0xfeff].includes(code)) {
      output += `\\u${code.toString(16).padStart(4, '0')}`;
      charsEscaped++;
      continue;
    }

    // Backslash - escape it to avoid ambiguity
    if (code === 0x5c) {
      output += '\\\\';
      charsEscaped++;
      continue;
    }

    output += input[i];
  }

  return {
    sanitized: output,
    isSafe: charsEscaped === 0,
    charsEscaped,
  };
}

function escapeChar(code: number): string {
  switch (code) {
    case 0x00:
      return '\\0';
    case 0x07:
      return '\\a';
    case 0x08:
      return '\\b';
    case 0x09:
      return '\\t';
    case 0x0a:
      return '\\n';
    case 0x0b:
      return '\\v';
    case 0x0c:
      return '\\f';
    case 0x0d:
      return '\\r';
    case 0x1b:
      return '\\x1b';
    default:
      return `\\x${code.toString(16).padStart(2, '0')}`;
  }
}

export function sanitizeObject(obj: any, depth = 0, maxDepth = 10): any {
  if (depth > maxDepth) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeLog(obj).sanitized;
  }

  if (obj instanceof Error) {
    return {
      name: sanitizeLog(obj.name).sanitized,
      message: sanitizeLog(obj.message).sanitized,
      stack: obj.stack ? sanitizeLog(obj.stack).sanitized : undefined,
    };
  }

  if (Array.isArray(obj)) {
    return obj.map((item, i) => (i > 100 ? '[TRUNCATED]' : sanitizeObject(item, depth + 1, maxDepth)));
  }

  if (typeof obj === 'object') {
    const result: any = {};
    let keyCount = 0;
    for (const [key, value] of Object.entries(obj)) {
      if (keyCount > 100) {
        result['[TRUNCATED]'] = true;
        break;
      }
      const sanitizedKey = sanitizeLog(key).sanitized;
      result[sanitizedKey] = sanitizeObject(value, depth + 1, maxDepth);
      keyCount++;
    }
    return result;
  }

  return obj;
}
