import { Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  childContext,
  newTraceContext,
  parseTraceparent,
  runWithTraceContext,
  sanitizeAttribute,
  SpanAttributeValue,
  emitSpan,
} from "./trace-context";

/**
 * Establishes the trace context for an HTTP request.
 *
 * A valid inbound `traceparent` makes this request's server span a child of the
 * caller's span (same trace id). A missing or malformed one starts a new trace:
 * the bad value is discarded, never repaired, and never echoed or logged, so a
 * client cannot inject a chosen trace id, oversized header or log-forging
 * payload through it.
 *
 * Because the context lives in AsyncLocalStorage for the rest of the request,
 * everything the handler starts (database writes that enqueue durable jobs,
 * contract calls, outbound webhooks) can read it without it being threaded
 * through signatures.
 */
@Injectable()
export class TraceContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = parseTraceparent(
      first(req.headers[TRACEPARENT_HEADER]),
      req.headers[TRACESTATE_HEADER],
    );
    const context = inbound ? childContext(inbound) : newTraceContext();

    const startTimeMs = Date.now();
    res.once("finish", () => {
      const attributes: Record<string, SpanAttributeValue> = {};
      const put = (key: string, value: unknown) => {
        const safe = sanitizeAttribute(key, value);
        if (safe !== undefined) attributes[key] = safe;
      };
      put("http.method", req.method);
      // The route TEMPLATE only. The concrete URL carries ids and is never used.
      put("http.route", (req as Request & { route?: { path?: string } }).route?.path);
      put("http.status_class", `${Math.floor(res.statusCode / 100)}xx`);
      emitSpan({
        name: "http.server",
        context,
        startTimeMs,
        endTimeMs: Date.now(),
        attributes,
        status: res.statusCode >= 500 ? "error" : "ok",
      });
    });

    runWithTraceContext(context, () => next());
  }
}

function first(value: string | string[] | undefined): string | undefined {
  // A repeated traceparent header is ambiguous; the spec says to restart.
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}
