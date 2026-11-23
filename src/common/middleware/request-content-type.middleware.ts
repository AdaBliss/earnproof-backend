import { BadRequestException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { RequestBodyRejectionReason } from "./compressed-request-body.middleware";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_MEDIA_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded",
] as const;

const ROUTE_MEDIA_TYPE_POLICIES = [
  {
    prefix: "/api/v1/credentials/verify",
    methods: ["POST"],
    mediaTypes: ["application/json"],
  },
  {
    prefix: "/api/v1/security/csp-reports",
    methods: ["POST"],
    mediaTypes: ["application/json"],
  },
] as const;

const REJECTION_TYPES: Record<ContentTypeRejectionReason, string> = {
  ambiguous_content_type: "request.content-type.ambiguous",
  missing_content_type: "request.content-type.missing",
  unsupported_charset: "request.content-type.charset.unsupported",
  unsupported_content_type: "request.content-type.unsupported",
};

type ContentTypeRejectionReason = Extract<
  RequestBodyRejectionReason,
  | "ambiguous_content_type"
  | "missing_content_type"
  | "unsupported_charset"
  | "unsupported_content_type"
>;

const REJECTION_MESSAGES: Record<ContentTypeRejectionReason, string> = {
  ambiguous_content_type: "The request Content-Type is ambiguous.",
  missing_content_type: "A Content-Type is required for this request body.",
  unsupported_charset: "The request charset must be UTF-8.",
  unsupported_content_type: "The request Content-Type is not supported.",
};

class RequestContentTypeError extends BadRequestException {
  readonly type: string;

  constructor(reason: ContentTypeRejectionReason) {
    super(REJECTION_MESSAGES[reason]);
    this.type = REJECTION_TYPES[reason];
  }
}

/**
 * Rejects ambiguous or unsupported representations before decompression,
 * parsing, authorization, or route handlers can inspect the body.
 */
export function requestContentTypeMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const contentTypeValues = getContentTypeHeaderValues(req);
  const hasBody = requestHasBody(req);
  if (!hasBody && !BODY_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  if (contentTypeValues.length === 0) {
    if (hasBody) {
      reject(res, next, "missing_content_type");
      return;
    }
    next();
    return;
  }

  if (contentTypeValues.length !== 1) {
    reject(res, next, "ambiguous_content_type");
    return;
  }

  const parsed = parseContentType(contentTypeValues[0]);
  if (!parsed) {
    const reason = hasAmbiguousContentTypeSyntax(contentTypeValues[0])
      ? "ambiguous_content_type"
      : "unsupported_content_type";
    reject(res, next, reason);
    return;
  }

  if (parsed.charset && !["utf-8", "utf8"].includes(parsed.charset)) {
    reject(res, next, "unsupported_charset");
    return;
  }

  if (!allowedMediaTypes(req.method, req.path).includes(parsed.mediaType)) {
    reject(res, next, "unsupported_content_type");
    return;
  }

  next();
}

export function requestContentTypeRejectionReason(
  error: unknown,
): RequestBodyRejectionReason | undefined {
  if (!error || typeof error !== "object") return undefined;
  const type = (error as { type?: unknown }).type;
  if (type === REJECTION_TYPES.ambiguous_content_type) {
    return "ambiguous_content_type";
  }
  if (type === REJECTION_TYPES.missing_content_type) {
    return "missing_content_type";
  }
  if (type === REJECTION_TYPES.unsupported_charset) {
    return "unsupported_charset";
  }
  if (type === REJECTION_TYPES.unsupported_content_type) {
    return "unsupported_content_type";
  }
  return undefined;
}

function getContentTypeHeaderValues(req: Request): string[] {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === "content-type") {
      values.push(req.rawHeaders[index + 1]);
    }
  }

  if (values.length > 0) return values;
  const normalized = req.headers["content-type"];
  if (Array.isArray(normalized)) return normalized;
  return normalized ? [normalized] : [];
}

function requestHasBody(req: Request): boolean {
  if (req.headers["transfer-encoding"]) return true;
  const contentLength = req.headers["content-length"];
  return contentLength !== undefined && Number(contentLength) > 0;
}

function parseContentType(
  value: string,
): { mediaType: string; charset?: string } | undefined {
  const parts = value.split(";");
  if (parts.length > 2 || value.includes(",")) return undefined;

  const mediaType = parts[0].trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(mediaType)) {
    return undefined;
  }

  if (parts.length === 1) return { mediaType };
  const parameter = /^charset\s*=\s*(?:"([^"]*)"|([^;\s"]+))$/i.exec(
    parts[1].trim(),
  );
  if (!parameter) return undefined;

  return {
    mediaType,
    charset: (parameter[1] ?? parameter[2]).toLowerCase(),
  };
}

function hasAmbiguousContentTypeSyntax(value: string): boolean {
  return value.includes(",") || (value.match(/;/g)?.length ?? 0) > 1;
}

function allowedMediaTypes(method: string, path: string): readonly string[] {
  const normalisedPath = path.toLowerCase();
  const policy = ROUTE_MEDIA_TYPE_POLICIES.find(
    (candidate) =>
      candidate.methods.some(
        (candidateMethod) => candidateMethod === method.toUpperCase(),
      ) &&
      (normalisedPath === candidate.prefix ||
        normalisedPath.startsWith(`${candidate.prefix}/`)),
  );
  return policy?.mediaTypes ?? DEFAULT_MEDIA_TYPES;
}

function reject(
  res: Response,
  next: NextFunction,
  reason: ContentTypeRejectionReason,
): void {
  res.setHeader("Connection", "close");
  next(new RequestContentTypeError(reason));
}
