import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

export const CORS_ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "PUT",
  "PATCH",
  "POST",
  "DELETE",
] as const;

export const CORS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "Idempotency-Key",
  "If-None-Match",
  "X-Organization-Id",
  "X-Request-ID",
] as const;

/**
 * Returns the canonical HTTP(S) origin only when the input is already an
 * origin serialization, rather than a URL containing path or user data.
 */
export function exactCorsOrigin(value: string): string | undefined {
  if (
    !value ||
    value !== value.trim() ||
    value === "*" ||
    value === "null" ||
    !URL.canParse(value)
  ) {
    return undefined;
  }

  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    return undefined;
  }

  return url.origin;
}

export function isExactCorsOrigin(value: string): boolean {
  return exactCorsOrigin(value) !== undefined;
}

export function createCorsOptions(configuredOrigin: string): CorsOptions {
  const allowedOrigin = exactCorsOrigin(configuredOrigin);
  if (!allowedOrigin) {
    throw new Error(
      "CORS origin must be one exact HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }

  return {
    origin: (requestOrigin, callback) => {
      callback(null, requestOrigin === allowedOrigin);
    },
    credentials: true,
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: ["x-request-id"],
    optionsSuccessStatus: 204,
  };
}
