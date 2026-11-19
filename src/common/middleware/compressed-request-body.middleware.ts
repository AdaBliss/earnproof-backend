import type { NextFunction, Request, Response } from "express";
import { parse as parseQueryString } from "querystring";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from "zlib";
import {
  bodyLimitForPath,
  MAX_BODY_EXPANSION_RATIO,
} from "../limits/request-limits";

export type RequestBodyRejectionReason =
  | "compressed_too_large"
  | "expanded_too_large"
  | "expansion_ratio_exceeded";

const REJECTION_TYPES: Record<RequestBodyRejectionReason, string> = {
  compressed_too_large: "request.compressed.too.large",
  expanded_too_large: "request.expanded.too.large",
  expansion_ratio_exceeded: "request.expansion.ratio.exceeded",
};

class RequestBodyLimitError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyLimitError";
  }
}

/**
 * Buffers only supported compressed JSON/form bodies, bounded by the route's
 * existing transport limit. Parsing happens only after both encoded and
 * decoded sizes have passed their limits.
 */
export function compressedRequestBodyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const encoding = req.headers["content-encoding"]?.trim().toLowerCase();
  if (
    !encoding ||
    encoding === "identity" ||
    !["gzip", "deflate", "br"].includes(encoding) ||
    (!req.is("application/json") &&
      !req.is("application/x-www-form-urlencoded")) ||
    !hasSupportedCharset(req)
  ) {
    next();
    return;
  }

  const compressedLimit = bodyLimitForPath(req.path);
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > compressedLimit) {
    res.setHeader("Connection", "close");
    next(rejectionError("compressed_too_large"));
    return;
  }

  let rejectedBeforeReadCompleted = false;
  const rejectEarly = (error: Error) => {
    if (rejectedBeforeReadCompleted) return;
    rejectedBeforeReadCompleted = true;
    res.setHeader("Connection", "close");
    next(error);
  };

  void readCompressedBody(req, compressedLimit, () =>
    rejectEarly(rejectionError("compressed_too_large")),
  )
    .then((compressed) => {
      if (rejectedBeforeReadCompleted) return;

      const expandedLimit = bodyLimitForPath(req.path);
      const ratioLimit = Math.floor(
        compressed.length * MAX_BODY_EXPANSION_RATIO,
      );
      const outputLimit = Math.min(expandedLimit, ratioLimit);
      let expanded: Buffer;

      try {
        expanded = decompress(compressed, encoding, outputLimit + 1);
      } catch (error) {
        if (isOutputLimitError(error)) {
          const reason =
            ratioLimit < expandedLimit
              ? "expansion_ratio_exceeded"
              : "expanded_too_large";
          throw rejectionError(reason);
        }
        throw parserError();
      }

      if (expanded.length > expandedLimit) {
        throw rejectionError("expanded_too_large");
      }
      if (expanded.length > ratioLimit) {
        throw rejectionError("expansion_ratio_exceeded");
      }

      req.body = parseBody(expanded, req);
      next();
    })
    .catch((error: unknown) => {
      if (!rejectedBeforeReadCompleted) next(error);
    });
}

/** Returns the bounded rejection reason carried by parser errors, if any. */
export function requestBodyRejectionReason(
  error: unknown,
): RequestBodyRejectionReason | undefined {
  if (!error || typeof error !== "object") return undefined;
  const type = (error as { type?: unknown }).type;

  if (
    type === "entity.too.large" ||
    type === REJECTION_TYPES.expanded_too_large
  ) {
    return "expanded_too_large";
  }
  if (type === REJECTION_TYPES.compressed_too_large) return "compressed_too_large";
  if (type === REJECTION_TYPES.expansion_ratio_exceeded) {
    return "expansion_ratio_exceeded";
  }
  return undefined;
}

async function readCompressedBody(
  req: Request,
  limit: number,
  onLimitExceeded: () => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;

  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;

    if (total > limit) {
      if (!exceeded) {
        exceeded = true;
        chunks.length = 0;
        onLimitExceeded();
      }
      continue;
    }

    if (!exceeded) chunks.push(bytes);
  }

  if (exceeded) throw rejectionError("compressed_too_large");
  return Buffer.concat(chunks, total);
}

function decompress(
  compressed: Buffer,
  encoding: string,
  maxOutputLength: number,
): Buffer {
  const options = { maxOutputLength };
  switch (encoding) {
    case "gzip":
      return gunzipSync(compressed, options);
    case "deflate":
      return inflateSync(compressed, options);
    case "br":
      return brotliDecompressSync(compressed, options);
    default:
      throw new Error("Unsupported content encoding.");
  }
}

function parseBody(body: Buffer, req: Request): unknown {
  if (body.length === 0) return {};

  const text = body.toString("utf8");
  if (req.is("application/json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object") throw parserError();
      return parsed;
    } catch {
      throw parserError();
    }
  }

  return parseQueryString(text);
}

function hasSupportedCharset(req: Request): boolean {
  const charset = /;\s*charset\s*=\s*"?([^;"\s]+)/i.exec(
    req.headers["content-type"] ?? "",
  )?.[1];
  return (
    !charset ||
    charset.toLowerCase() === "utf-8" ||
    charset.toLowerCase() === "utf8"
  );
}

function isOutputLimitError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

function rejectionError(
  reason: RequestBodyRejectionReason,
): RequestBodyLimitError {
  const messages: Record<RequestBodyRejectionReason, string> = {
    compressed_too_large:
      "The compressed request exceeds the maximum permitted size.",
    expanded_too_large:
      "The expanded request exceeds the maximum permitted size.",
    expansion_ratio_exceeded:
      "The request exceeds the maximum permitted expansion ratio.",
  };
  return new RequestBodyLimitError(REJECTION_TYPES[reason], messages[reason]);
}

function parserError(): RequestBodyLimitError {
  return new RequestBodyLimitError(
    "entity.parse.failed",
    "The request body could not be read as JSON.",
  );
}
