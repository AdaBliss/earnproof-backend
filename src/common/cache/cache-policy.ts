import { RouteClassification, CACHE_POLICY_MATRIX } from './route-classification';

export interface CacheHeaders {
  'Cache-Control': string;
  'Vary': string;
  'Pragma'?: string;
}

export function computeCacheHeaders(
  classification: RouteClassification,
  method: string,
  status: number,
  existingVary?: string
): CacheHeaders {
  // Non-safe methods never cached
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    return {
      'Cache-Control': 'no-store, must-revalidate',
      'Vary': buildVaryHeader(existingVary),
    };
  }

  // Error responses never cached
  if (status >= 400) {
    return {
      'Cache-Control': 'no-store, must-revalidate',
      'Vary': buildVaryHeader(existingVary),
    };
  }

  const policy = CACHE_POLICY_MATRIX[classification] || CACHE_POLICY_MATRIX[RouteClassification.SENSITIVE];

  const headers: CacheHeaders = {
    'Cache-Control': policy.cacheControl,
    'Vary': buildVaryHeader(existingVary),
  };

  if (classification === RouteClassification.SENSITIVE) {
    headers['Pragma'] = 'no-cache';
  }

  return headers;
}

export function buildVaryHeader(existing?: string): string {
  const varyValues = new Set<string>();

  // Always required
  varyValues.add('Authorization');
  varyValues.add('Cookie');
  varyValues.add('Accept-Encoding');

  // Add tenant header if in use
  varyValues.add('X-Tenant-Id');

  // Merge with existing
  if (existing) {
    const parts = existing.split(',').map(v => v.trim());
    parts.forEach(v => varyValues.add(v));
  }

  // Return stable order
  return Array.from(varyValues).sort().join(', ');
}
