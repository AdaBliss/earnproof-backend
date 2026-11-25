export enum RouteClassification {
  PUBLIC_STATIC = 'PUBLIC_STATIC',
  PUBLIC_DYNAMIC = 'PUBLIC_DYNAMIC',
  AUTHENTICATED = 'AUTHENTICATED',
  SENSITIVE = 'SENSITIVE',
}

export const CACHE_POLICY_MATRIX = {
  [RouteClassification.PUBLIC_STATIC]: {
    cacheControl: 'public, max-age=3600, s-maxage=3600',
    maxAgeCap: 24 * 60 * 60,
  },
  [RouteClassification.PUBLIC_DYNAMIC]: {
    cacheControl: 'public, max-age=300, s-maxage=300',
    maxAgeCap: 60 * 60,
  },
  [RouteClassification.AUTHENTICATED]: {
    cacheControl: 'no-store, private',
    maxAgeCap: 0,
  },
  [RouteClassification.SENSITIVE]: {
    cacheControl: 'no-store, no-cache, private, must-revalidate, proxy-revalidate',
    maxAgeCap: 0,
  },
} as const;
