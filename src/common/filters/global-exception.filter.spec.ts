import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { GlobalExceptionFilter } from "./global-exception.filter";
import { ApiErrorCode } from "../dto/api-error.dto";
import { RequestAbortedError } from "../request-context/request-abort";

// ─── Minimal mock helpers ─────────────────────────────────────────────────────

function makeHost(requestOverrides: Record<string, unknown> = {}): {
  host: ArgumentsHost;
  json: jest.Mock;
  setHeader: jest.Mock;
  status: jest.Mock;
} {
  const json = jest.fn();
  const setHeader = jest.fn();
  const status = jest.fn().mockReturnValue({ json });

  const request = {
    headers: {},
    requestId: "test-request-id",
    ...requestOverrides,
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ status, setHeader }),
    }),
  } as unknown as ArgumentsHost;

  return { host, json, setHeader, status };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GlobalExceptionFilter", () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jest.spyOn(filter["logger"], "error").mockImplementation(() => undefined);
    jest.spyOn(filter["logger"], "warn").mockImplementation(() => undefined);
  });

  // ── Request-ID propagation ────────────────────────────────────────────────

  describe("requestId propagation", () => {
    it("uses req.requestId when present", () => {
      const { host, json } = makeHost({ requestId: "my-req-id" });
      filter.catch(new NotFoundException(), host);
      expect(json.mock.calls[0][0]).toMatchObject({ requestId: "my-req-id" });
    });

    it("falls back to x-request-id header when req.requestId is absent", () => {
      const { host, json } = makeHost({
        requestId: undefined,
        headers: { "x-request-id": "header-id" },
      });
      filter.catch(new NotFoundException(), host);
      expect(json.mock.calls[0][0]).toMatchObject({ requestId: "header-id" });
    });

    it("generates a fresh id when neither source is available", () => {
      const { host, json } = makeHost({ requestId: undefined, headers: {} });
      filter.catch(new NotFoundException(), host);
      const { requestId } = json.mock.calls[0][0] as { requestId: string };
      expect(requestId).toMatch(/^[a-f0-9]{32}$/);
    });

    it("rejects an unsafe x-request-id header and generates a fresh id", () => {
      const { host, json } = makeHost({
        requestId: undefined,
        headers: { "x-request-id": "<script>xss</script>" },
      });
      filter.catch(new NotFoundException(), host);
      const { requestId } = json.mock.calls[0][0] as { requestId: string };
      expect(requestId).not.toBe("<script>xss</script>");
      expect(requestId).toMatch(/^[a-f0-9]{32}$/);
    });
  });

  // ── 401 Unauthorized sub-codes ────────────────────────────────────────────

  describe("UnauthorizedException mapping", () => {
    const cases: [string, ApiErrorCode, string][] = [
      [
        "Missing bearer token",
        ApiErrorCode.MISSING_TOKEN,
        "Authentication is required",
      ],
      ["Malformed auth token", ApiErrorCode.INVALID_TOKEN, "malformed"],
      ["Invalid auth token", ApiErrorCode.INVALID_TOKEN, "invalid"],
      ["Expired auth token", ApiErrorCode.EXPIRED_TOKEN, "expired"],
      [
        "Challenge is expired or unavailable",
        ApiErrorCode.INVALID_CREDENTIALS,
        "challenge",
      ],
      [
        "Invalid wallet signature",
        ApiErrorCode.INVALID_CREDENTIALS,
        "signature",
      ],
      [
        "User session is no longer valid",
        ApiErrorCode.SESSION_EXPIRED,
        "session",
      ],
    ];

    it.each(cases)(
      'maps "%s" → code %s',
      (exceptionMessage, expectedCode, messageFragment) => {
        const { host, json, status } = makeHost();
        filter.catch(new UnauthorizedException(exceptionMessage), host);
        expect(status).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
        const body = json.mock.calls[0][0] as { code: string; message: string };
        expect(body.code).toBe(expectedCode);
        expect(body.message.toLowerCase()).toContain(
          messageFragment.toLowerCase(),
        );
      },
    );

    it("falls back to INVALID_TOKEN for unknown 401 messages", () => {
      const { host, json } = makeHost();
      filter.catch(new UnauthorizedException("Some unknown auth error"), host);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.INVALID_TOKEN,
      });
    });
  });

  // ── Validation errors → 422 with violations ───────────────────────────────

  describe("ValidationPipe 400 → 422 promotion", () => {
    it("promotes to 422 and populates violations array", () => {
      const { host, json, status } = makeHost();
      const nestValidationError = new BadRequestException({
        message: [
          "walletAddress must be exactly 56 characters",
          "signature should not be empty",
        ],
        error: "Bad Request",
        statusCode: 400,
      });
      filter.catch(nestValidationError, host);
      expect(status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      const body = json.mock.calls[0][0] as {
        code: string;
        violations: { field: string; message: string }[];
      };
      expect(body.code).toBe(ApiErrorCode.VALIDATION_ERROR);
      expect(body.violations).toHaveLength(2);
      expect(body.violations[0]).toMatchObject({ field: "walletAddress" });
      expect(body.violations[1]).toMatchObject({ field: "signature" });
    });

    it("surfaces the developer message for plain-string 400 exceptions", () => {
      const { host, json, status } = makeHost();
      filter.catch(
        new BadRequestException("periodStart must be before periodEnd"),
        host,
      );
      expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      const body = json.mock.calls[0][0] as { code: string; message: string };
      expect(body.code).toBe(ApiErrorCode.INVALID_INPUT);
      expect(body.message).toContain("periodStart must be before periodEnd");
    });
  });

  // ── Other HTTP exceptions ─────────────────────────────────────────────────

  describe("HTTP exception mapping", () => {
    it("maps NotFoundException → 404 NOT_FOUND", () => {
      const { host, json, status } = makeHost();
      filter.catch(new NotFoundException("Payment not found"), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.NOT_FOUND,
      });
    });

    it("preserves allowlisted domain error codes", () => {
      const { host, json, status } = makeHost();
      filter.catch(
        new UnprocessableEntityException({
          code: ApiErrorCode.PAYMENT_EXCLUDED,
          message: "Payment is excluded from proof issuance",
        }),
        host,
      );

      expect(status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.PAYMENT_EXCLUDED,
        message: "Payment is excluded from proof issuance",
      });
    });

    it("maps ForbiddenException → 403 FORBIDDEN", () => {
      const { host, json, status } = makeHost();
      filter.catch(new ForbiddenException(), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.FORBIDDEN,
      });
    });

    it("maps dependency exceptions to 503 DEPENDENCY_UNAVAILABLE", () => {
      const { host, json, status } = makeHost();
      filter.catch(
        new ServiceUnavailableException("private dependency detail"),
        host,
      );
      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.DEPENDENCY_UNAVAILABLE,
      });
      expect(JSON.stringify(json.mock.calls[0][0])).not.toContain(
        "private dependency detail",
      );
    });
  });

  // ── Prisma error mapping ──────────────────────────────────────────────────

  describe("Prisma error mapping", () => {
    function makePrismaKnown(code: string) {
      return new Prisma.PrismaClientKnownRequestError("prisma error", {
        code,
        clientVersion: "6.0.0",
      });
    }

    it("maps P2025 (record not found) → 404 NOT_FOUND", () => {
      const { host, json, status } = makeHost();
      filter.catch(makePrismaKnown("P2025"), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.NOT_FOUND,
      });
    });

    it("maps P2002 (unique violation) → 409 CONFLICT", () => {
      const { host, json, status } = makeHost();
      filter.catch(makePrismaKnown("P2002"), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.CONFLICT,
      });
    });

    it("maps P2003 (foreign-key violation) → 409 CONFLICT", () => {
      const { host, json, status } = makeHost();
      filter.catch(makePrismaKnown("P2003"), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.CONFLICT,
      });
    });

    it("maps P1001 (connection error) → 503 DEPENDENCY_UNAVAILABLE", () => {
      const { host, json, status } = makeHost();
      filter.catch(makePrismaKnown("P1001"), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.DEPENDENCY_UNAVAILABLE,
      });
    });

    it("maps unknown Prisma P-codes → 500 INTERNAL_ERROR", () => {
      const { host, json, status } = makeHost();
      filter.catch(makePrismaKnown("P9999"), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.INTERNAL_ERROR,
      });
    });

    it("maps PrismaClientUnknownRequestError → 503 DEPENDENCY_UNAVAILABLE", () => {
      const { host, json, status } = makeHost();
      filter.catch(
        new Prisma.PrismaClientUnknownRequestError("unknown", {
          clientVersion: "6.0.0",
        }),
        host,
      );
      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.DEPENDENCY_UNAVAILABLE,
      });
    });

    it("maps PrismaClientInitializationError → 503 DEPENDENCY_UNAVAILABLE", () => {
      const { host, status } = makeHost();
      filter.catch(
        new Prisma.PrismaClientInitializationError("init error", "6.0.0"),
        host,
      );
      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it("maps PrismaClientValidationError → 500 INTERNAL_ERROR (programmer error)", () => {
      const { host, json, status } = makeHost();
      filter.catch(
        new Prisma.PrismaClientValidationError("validation error", {
          clientVersion: "6.0.0",
        }),
        host,
      );
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.INTERNAL_ERROR,
      });
    });
  });

  // ── Exhausted transaction retries ─────────────────────────────────────────

  describe("transaction retry exhaustion", () => {
    it("maps an exhausted retry → 503 DEPENDENCY_UNAVAILABLE with a stable code", () => {
      const { host, json, status } = makeHost();
      filter.catch(
        new TransactionRetryExhaustedError(
          "test-operation",
          3,
          "deadlock",
          "P2034",
          new Error("deadlock detected"),
        ),
        host,
      );
      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.DEPENDENCY_UNAVAILABLE,
      });
    });

    it("does not leak the operation name, category, or Prisma code in the response", () => {
      const { host, json } = makeHost();
      filter.catch(
        new TransactionRetryExhaustedError(
          "test-operation",
          3,
          "deadlock",
          "P2034",
          new Error("deadlock detected"),
        ),
        host,
      );
      const body = JSON.stringify(json.mock.calls[0][0]);
      expect(body).not.toContain("test-operation");
      expect(body).not.toContain("deadlock");
      expect(body).not.toContain("P2034");
    });
  });

  // ── Unknown / unhandled errors ────────────────────────────────────────────

  describe("unknown exception mapping", () => {
    it("maps plain Error → 500 INTERNAL_ERROR", () => {
      const { host, json, status } = makeHost();
      filter.catch(new Error("something exploded"), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(json.mock.calls[0][0]).toMatchObject({
        code: ApiErrorCode.INTERNAL_ERROR,
      });
    });

    it("does NOT include the internal error message in the response body", () => {
      const { host, json } = makeHost();
      filter.catch(new Error("SELECT * FROM users -- internal detail"), host);
      const body = json.mock.calls[0][0] as { message: string };
      expect(body.message).not.toContain("SELECT");
      expect(body.message).not.toContain("internal detail");
    });

    it("maps a non-Error thrown value → 500 INTERNAL_ERROR", () => {
      const { host, status } = makeHost();
      filter.catch("some string thrown", host);
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });

  // ── Redaction: no internal leakage ───────────────────────────────────────

  describe("internal detail redaction", () => {
    it("does not leak Prisma error codes in the response", () => {
      const { host, json } = makeHost();
      filter.catch(
        new Prisma.PrismaClientKnownRequestError("prisma error", {
          code: "P2002",
          clientVersion: "6.0.0",
        }),
        host,
      );
      const body = JSON.stringify(json.mock.calls[0][0]);
      expect(body).not.toContain("P2002");
      expect(body).not.toContain("prisma error");
    });

    it("does not leak stack traces in the response", () => {
      const err = new Error("crash");
      const { host, json } = makeHost();
      filter.catch(err, host);
      const body = JSON.stringify(json.mock.calls[0][0]);
      expect(body).not.toContain("global-exception.filter");
    });

    it("does not leak auth token messages verbatim", () => {
      const { host, json } = makeHost();
      filter.catch(new UnauthorizedException("Invalid auth token"), host);
      const body = JSON.stringify(json.mock.calls[0][0]);
      // The raw internal message "Invalid auth token" must not appear;
      // the filter emits its own safe replacement.
      expect(body).not.toContain("Invalid auth token");
    });
  });

  // ── Envelope shape snapshot ───────────────────────────────────────────────

  describe("envelope shape", () => {
    it("always includes statusCode, code, message, and requestId", () => {
      const exceptions = [
        new NotFoundException(),
        new UnauthorizedException("Missing bearer token"),
        new BadRequestException("bad input"),
        new Error("unexpected"),
      ];

      for (const exception of exceptions) {
        const { host, json } = makeHost();
        filter.catch(exception, host);
        const body = json.mock.calls[0][0] as Record<string, unknown>;
        expect(body).toHaveProperty("statusCode");
        expect(body).toHaveProperty("code");
        expect(body).toHaveProperty("message");
        expect(body).toHaveProperty("requestId");
        json.mockClear();
      }
    });

    it("includes violations only when code is VALIDATION_ERROR", () => {
      const { host: h1, json: j1 } = makeHost();
      filter.catch(
        new BadRequestException({
          message: ["field must not be empty"],
          error: "Bad Request",
          statusCode: 400,
        }),
        h1,
      );
      expect(j1.mock.calls[0][0]).toHaveProperty("violations");

      const { host: h2, json: j2 } = makeHost();
      filter.catch(new NotFoundException(), h2);
      expect(j2.mock.calls[0][0]).not.toHaveProperty("violations");
    });
  });

  describe("client-aborted requests", () => {
    it("maps RequestAbortedError to 499 REQUEST_ABORTED, not an internal error", () => {
      const filter = new GlobalExceptionFilter();
      const { host, status, json } = makeHost();

      filter.catch(new RequestAbortedError(), host);

      expect(status).toHaveBeenCalledWith(499);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 499, code: ApiErrorCode.REQUEST_ABORTED }),
      );
      expect(json.mock.calls[0][0].code).not.toBe(ApiErrorCode.INTERNAL_ERROR);
    });

    it("does not log a cancellation as an error", () => {
      const filter = new GlobalExceptionFilter();
      const errorLog = jest
        .spyOn((filter as unknown as { logger: { error: () => void } }).logger, "error")
        .mockImplementation();
      const { host } = makeHost();

      filter.catch(new RequestAbortedError(), host);

      expect(errorLog).not.toHaveBeenCalled();
    });
  });
});
