export type ErrorClassification = 'TRANSIENT' | 'PERMANENT' | 'UNKNOWN';

export interface ClassificationResult {
  classification: ErrorClassification;
  reasonCode?: string;
}

export function classifyJobError(error: unknown): ClassificationResult {
  if (!error) {
    return { classification: 'UNKNOWN' };
  }

  const errorMsg = error instanceof Error ? error.message : String(error);
  const errorCode = (error as any)?.code || '';

  // Transient patterns
  const transientPatterns = [
    /timeout/i,
    /ETIMEDOUT/,
    /ECONNREFUSED/,
    /ECONNRESET/,
    /429/,
    /rate.?limit/i,
    /temporarily unavailable/i,
    /service unavailable/i,
  ];

  for (const pattern of transientPatterns) {
    if (pattern.test(errorMsg) || pattern.test(errorCode)) {
      return { classification: 'TRANSIENT', reasonCode: 'TRANSIENT_NETWORK' };
    }
  }

  // Permanent patterns
  const permanentPatterns = [
    /unauthorized|401/i,
    /forbidden|403/i,
    /not.?found|404/i,
    /invalid.?input|malformed|bad.?request/i,
    /duplicate|already.?exists|conflict/i,
    /contract.*not.*found/i,
  ];

  for (const pattern of permanentPatterns) {
    if (pattern.test(errorMsg) || pattern.test(errorCode)) {
      return { classification: 'PERMANENT', reasonCode: 'PERMANENT_CHAIN_REJECTION' };
    }
  }

  return { classification: 'UNKNOWN' };
}
