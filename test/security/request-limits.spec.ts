import {
  Body,
  CanActivate,
  Controller,
  INestApplication,
  Module,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { brotliCompressSync, deflateSync, gzipSync } from "zlib";
import { configureApp } from "../../src/bootstrap";
import { ApiErrorCode } from "../../src/common/dto/api-error.dto";
import {
  METRIC_NAMES,
  registerCoreMetrics,
} from "../../src/common/observability/metrics.catalog";
import { MetricsRegistry } from "../../src/common/observability/metrics.registry";
import {
  FIELD_LIMITS,
  GLOBAL_BODY_LIMIT_BYTES,
  MAX_BODY_EXPANSION_RATIO,
  PAYLOAD_SHAPE_LIMITS,
  ROUTE_BODY_LIMITS,
  bodyLimitForPath,
} from "../../src/common/limits/request-limits";
import { listen, postBytes, postJson, postRaw } from "./http-client";

/**
 * Transport and structural request limits.
 *
 * The application is configured by `configureApp`, the same function `main.ts`
 * calls, so these tests exercise the real pipeline: the real body parsers with
 * the real limits, the real shape middleware, the real validation pipe and the
 * real error filter. A test that rebuilt the pipeline by hand would pass while
 * production ran without any of it.
 *
 * The controller is a stand-in rather than a real one, on purpose. What is
 * under test is the boundary every route sits behind, and a real controller
 * would drag in a database, a Stellar client and an authentication guard — none
 * of which an oversized request should ever reach, which is the point.
 */

class ProbeDto {
  @IsOptional()
  @IsString()
  @MaxLength(FIELD_LIMITS.name)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FIELD_LIMITS.paymentIdsPerProof)
  @IsString({ each: true })
  @MaxLength(FIELD_LIMITS.id, { each: true })
  ids?: string[];
}

/** Records whether a request ever reached a handler. */
const handled = { count: 0 };
const guarded = { count: 0 };

class ProbeAuthGuard implements CanActivate {
  canActivate(): boolean {
    guarded.count += 1;
    throw new UnauthorizedException("Missing bearer token");
  }
}

@Controller()
class ProbeController {
  @Post("probe")
  probe(@Body() body: ProbeDto) {
    handled.count += 1;
    return { ok: true, ids: body.ids?.length ?? 0 };
  }

  // Mounted under the auth prefix so the tighter route limit applies.
  @Post("auth/probe")
  authProbe(@Body() body: ProbeDto) {
    handled.count += 1;
    return { ok: true, name: body.name ?? null };
  }

  @Post("auth/protected/probe")
  @UseGuards(ProbeAuthGuard)
  protectedProbe(@Body() body: ProbeDto) {
    handled.count += 1;
    return { ok: true, name: body.name ?? null };
  }

  @Post("credentials/verify")
  verifyCredential(@Body() body: ProbeDto) {
    handled.count += 1;
    return { ok: true, name: body.name ?? null };
  }
}

@Module({ controllers: [ProbeController], providers: [ProbeAuthGuard] })
class ProbeModule {}

/** A JSON document of roughly `bytes` bytes, valid against ProbeDto. */
function bodyOfSize(bytes: number): string {
  // One oversized string field: the simplest way to be large while remaining
  // well-formed JSON that the parser would happily read were it permitted to.
  return JSON.stringify({ name: "x".repeat(bytes) });
}

/**
 * A JSON document nested `depth` levels, built as text.
 *
 * Not via `JSON.stringify` on a nested object: that serialiser recurses, so the
 * *test* would be the thing that overflows.
 */
function nestedJson(depth: number): string {
  return `${'{"child":'.repeat(depth)}1${"}".repeat(depth)}`;
}

function padGzipToLength(gzip: Buffer, targetLength: number): Buffer {
  const extraLength = targetLength - gzip.length - 2;
  if (gzip.length < 10 || extraLength < 0 || extraLength > 0xffff) {
    throw new Error("Cannot pad this gzip fixture to the requested length.");
  }

  const header = Buffer.from(gzip.subarray(0, 10));
  header[3] |= 0x04;
  const fieldLength = Buffer.alloc(2);
  fieldLength.writeUInt16LE(extraLength);
  return Buffer.concat([
    header,
    fieldLength,
    Buffer.alloc(extraLength),
    gzip.subarray(10),
  ]);
}

function requestBodyRejections(metrics: MetricsRegistry): Array<{
  labels: { rejection?: string };
  value: number;
}> {
  const metric = metrics.snapshot().find(
    (entry) => entry.name === METRIC_NAMES.requestBodyRejectionsTotal,
  );
  if (!metric || metric.type !== "counter") {
    throw new Error("Request-body rejection metric is not registered.");
  }
  return metric.series;
}

describe("request resource limits", () => {
  let app: INestApplication;
  let baseUrl: string;
  let metrics: MetricsRegistry;

  beforeAll(async () => {
    metrics = new MetricsRegistry();
    registerCoreMetrics(metrics);

    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app, { metrics });
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    handled.count = 0;
    guarded.count = 0;
    metrics.reset();
  });

  describe("body size", () => {
    it("accepts a body inside the global limit", async () => {
      const response = await postJson(baseUrl, "/api/v1/probe", {
        ids: ["payment-1", "payment-2"],
      });

      expect(response.status).toBe(201);
      expect(handled.count).toBe(1);
    });

    describe("compressed body size", () => {
      it("accepts a valid gzip JSON body and preserves its parsed values", async () => {
        const body = gzipSync(Buffer.from(JSON.stringify({ name: "compressed" })));
        const response = await postBytes(baseUrl, "/api/v1/probe", body, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });

        expect(response.status).toBe(201);
        expect(response.json).toMatchObject({ ok: true });
        expect(handled.count).toBe(1);
        expect(requestBodyRejections(metrics)).toHaveLength(0);
      });

      it("preserves gzip, deflate, and Brotli JSON support", async () => {
        const input = Buffer.from(JSON.stringify({ name: "compressed" }));
        const compressedBodies = [
          { encoding: "gzip", body: gzipSync(input) },
          { encoding: "deflate", body: deflateSync(input) },
          { encoding: "br", body: brotliCompressSync(input) },
        ];

        for (const { encoding, body } of compressedBodies) {
          const response = await postBytes(baseUrl, "/api/v1/probe", body, {
            "content-type": "application/json",
            "content-encoding": encoding,
          });
          expect(response.status).toBe(201);
          expect(response.json).toMatchObject({ ok: true });
        }
        expect(handled.count).toBe(3);
      });

      it("preserves compressed URL-encoded request parsing", async () => {
        const body = gzipSync(Buffer.from("name=compressed"));
        const response = await postBytes(baseUrl, "/api/v1/probe", body, {
          "content-type": "application/x-www-form-urlencoded",
          "content-encoding": "gzip",
        });

        expect(response.status).toBe(201);
        expect(response.json).toMatchObject({ ok: true });
        expect(handled.count).toBe(1);
      });

      it("accepts exact compressed, expanded, and ratio boundaries", async () => {
        const authLimit = bodyLimitForPath("/api/v1/auth/probe");
        const exactCompressed = padGzipToLength(
          gzipSync(Buffer.from(JSON.stringify({ name: "x" }))),
          authLimit,
        );
        const compressedResponse = await postBytes(
          baseUrl,
          "/api/v1/auth/probe",
          exactCompressed,
          {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        );
        expect(compressedResponse.status).toBe(201);

        const json = JSON.stringify({ name: "ok" });
        const expanded = Buffer.from(
          `${json}${" ".repeat(GLOBAL_BODY_LIMIT_BYTES - Buffer.byteLength(json))}`,
        );
        const exactExpanded = padGzipToLength(
          gzipSync(expanded),
          Math.ceil(expanded.length / MAX_BODY_EXPANSION_RATIO),
        );
        const expandedResponse = await postBytes(
          baseUrl,
          "/api/v1/probe",
          exactExpanded,
          {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        );
        expect(expanded.length).toBe(GLOBAL_BODY_LIMIT_BYTES);
        expect(expandedResponse.status).toBe(201);

        const ratioBoundary = Buffer.from(
          JSON.stringify({ name: "x".repeat(7_989) }),
        );
        expect(ratioBoundary.length).toBe(8_000);
        const exactRatio = padGzipToLength(
          gzipSync(ratioBoundary),
          ratioBoundary.length / MAX_BODY_EXPANSION_RATIO,
        );
        const ratioResponse = await postBytes(
          baseUrl,
          "/api/v1/probe",
          exactRatio,
          {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        );
        expect(ratioResponse.status).toBe(422);
        expect(ratioResponse.json?.code).toBe(ApiErrorCode.VALIDATION_ERROR);
        expect(requestBodyRejections(metrics)).toHaveLength(0);
      });

      it("refuses compressed input over the route limit before parsing", async () => {
        const authLimit = bodyLimitForPath("/api/v1/auth/probe");
        const response = await postBytes(
          baseUrl,
          "/api/v1/auth/protected/probe",
          Buffer.alloc(authLimit + 1),
          {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        );

        expect(response.status).toBe(413);
        expect(response.json?.code).toBe(ApiErrorCode.PAYLOAD_TOO_LARGE);
        expect(handled.count).toBe(0);
        expect(guarded.count).toBe(0);
        expect(requestBodyRejections(metrics)).toEqual([
          { labels: { rejection: "compressed_too_large" }, value: 1 },
        ]);
      });

      it("still applies authorization to a valid compressed request", async () => {
        const body = gzipSync(Buffer.from(JSON.stringify({ name: "valid" })));
        const response = await postBytes(
          baseUrl,
          "/api/v1/auth/protected/probe",
          body,
          {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
        );

        expect(response.status).toBe(401);
        expect(response.json?.code).toBe(ApiErrorCode.MISSING_TOKEN);
        expect(guarded.count).toBe(1);
        expect(handled.count).toBe(0);
      });

      it("refuses decoded output over the expanded limit before JSON parsing", async () => {
        const repetitiveBlock = Buffer.alloc(1_000);
        for (let index = 0; index < repetitiveBlock.length; index += 1) {
          repetitiveBlock[index] = (index * 37 + 11) % 256;
        }
        const value = repetitiveBlock.toString("base64").repeat(100);
        const body = gzipSync(Buffer.from(JSON.stringify({ name: value })));
        expect(body.length).toBeLessThan(GLOBAL_BODY_LIMIT_BYTES);

        const response = await postBytes(baseUrl, "/api/v1/probe", body, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });

        expect(response.status).toBe(413);
        expect(response.json?.code).toBe(ApiErrorCode.PAYLOAD_TOO_LARGE);
        expect(handled.count).toBe(0);
        expect(requestBodyRejections(metrics)).toEqual([
          { labels: { rejection: "expanded_too_large" }, value: 1 },
        ]);
      });

      it("refuses expansion ratios over the configured boundary", async () => {
        const body = gzipSync(
          Buffer.from(JSON.stringify({ name: "x".repeat(8_000) })),
        );
        expect(body.length * MAX_BODY_EXPANSION_RATIO).toBeLessThan(8_000);

        const response = await postBytes(baseUrl, "/api/v1/probe", body, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });

        expect(response.status).toBe(413);
        expect(response.json?.code).toBe(ApiErrorCode.PAYLOAD_TOO_LARGE);
        expect(handled.count).toBe(0);
        expect(requestBodyRejections(metrics)).toEqual([
          { labels: { rejection: "expansion_ratio_exceeded" }, value: 1 },
        ]);
      });

      it("does not include compressed payload content in the error response", async () => {
        const marker = "SECRET";
        const body = gzipSync(
          Buffer.from(JSON.stringify({ name: marker + "x".repeat(8_000) })),
        );
        const response = await postBytes(baseUrl, "/api/v1/probe", body, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });

        expect(response.status).toBe(413);
        expect(response.text).not.toContain(marker);
      });
    });

    it("refuses a body over the global limit with the standard error", async () => {
      const response = await postRaw(
        baseUrl,
        "/api/v1/probe",
        bodyOfSize(GLOBAL_BODY_LIMIT_BYTES * 2),
      );

      expect(response.status).toBe(413);
      expect(response.json).toMatchObject({
        statusCode: 413,
        code: ApiErrorCode.PAYLOAD_TOO_LARGE,
      });
      // The envelope every other error uses, including the correlation id.
      expect(response.json?.requestId).toEqual(expect.any(String));
      expect(requestBodyRejections(metrics)).toEqual([
        { labels: { rejection: "expanded_too_large" }, value: 1 },
      ]);
    });

    it("never reaches the handler with an oversized body", async () => {
      // The property that matters: the body is refused while it is still bytes
      // on a socket. Nothing parses it, nothing validates it, no handler runs.
      const response = await postRaw(
        baseUrl,
        "/api/v1/probe",
        bodyOfSize(GLOBAL_BODY_LIMIT_BYTES * 4),
      );

      expect(response.status).toBe(413);
      expect(handled.count).toBe(0);
    });

    it("does not echo any part of the payload in the error", async () => {
      // An error that quotes the body puts an oversized — and possibly
      // sensitive — payload into the response and the log, which is the same
      // failure one layer down.
      const marker = "SENTINELVALUE";
      const response = await postRaw(
        baseUrl,
        "/api/v1/probe",
        JSON.stringify({
          name: marker + "y".repeat(GLOBAL_BODY_LIMIT_BYTES * 2),
        }),
      );

      expect(response.status).toBe(413);
      expect(response.text).not.toContain(marker);
      expect(response.text).not.toMatch(/y{20}/);
    });

    it("applies the tighter limit on the authentication routes", async () => {
      const authLimit = bodyLimitForPath("/api/v1/auth/probe");
      expect(authLimit).toBeLessThan(GLOBAL_BODY_LIMIT_BYTES);

      // Over the auth limit, under the global one: accepted anywhere else,
      // refused here.
      const response = await postRaw(
        baseUrl,
        "/api/v1/auth/probe",
        bodyOfSize(authLimit * 2),
      );

      expect(response.status).toBe(413);
      expect(handled.count).toBe(0);
    });

    it("still accepts a normal request on a tightened route", async () => {
      const response = await postJson(baseUrl, "/api/v1/auth/probe", {
        name: "wallet-challenge",
      });

      expect(response.status).toBe(201);
      expect(handled.count).toBe(1);
    });

    it("reports malformed JSON as invalid input, not as an internal error", async () => {
      const response = await postRaw(baseUrl, "/api/v1/probe", "{ not json");

      expect(response.status).toBe(400);
      expect(response.json?.code).toBe(ApiErrorCode.INVALID_INPUT);
    });
  });

  describe("request representation", () => {
    it("accepts UTF-8 JSON with an explicit charset", async () => {
      const response = await postBytes(
        baseUrl,
        "/api/v1/probe",
        Buffer.from(JSON.stringify({ name: "utf8" })),
        { "content-type": "application/json; charset=utf-8" },
      );

      expect(response.status).toBe(201);
      expect(handled.count).toBe(1);
    });

    it("preserves URL-encoded bodies on routes that allow form input", async () => {
      const response = await postBytes(
        baseUrl,
        "/api/v1/probe",
        Buffer.from("name=form"),
        { "content-type": "application/x-www-form-urlencoded" },
      );

      expect(response.status).toBe(201);
      expect(handled.count).toBe(1);
    });

    it.each([
      [
        "unsupported media type",
        "text/plain",
        ApiErrorCode.INVALID_INPUT,
        "unsupported_content_type",
      ],
      [
        "conflicting media types",
        "application/json, application/x-www-form-urlencoded",
        ApiErrorCode.INVALID_INPUT,
        "ambiguous_content_type",
      ],
      [
        "unsupported charset",
        "application/json; charset=utf-16",
        ApiErrorCode.INVALID_INPUT,
        "unsupported_charset",
      ],
      [
        "duplicate charset parameters",
        "application/json; charset=utf-8; charset=utf-16",
        ApiErrorCode.INVALID_INPUT,
        "ambiguous_content_type",
      ],
    ])(
      "rejects %s before authorization or handler execution",
      async (_label, contentType, code, rejection) => {
        const response = await postBytes(
          baseUrl,
          "/api/v1/auth/protected/probe",
          Buffer.from(JSON.stringify({ name: "must-not-be-read" })),
          { "content-type": contentType },
        );

        expect(response.status).toBe(400);
        expect(response.json?.code).toBe(code);
        expect(response.text).not.toContain("must-not-be-read");
        expect(guarded.count).toBe(0);
        expect(handled.count).toBe(0);
        expect(requestBodyRejections(metrics)).toEqual([
          { labels: { rejection }, value: 1 },
        ]);
      },
    );

    it("rejects a body without Content-Type before parsing", async () => {
      const response = await postBytes(
        baseUrl,
        "/api/v1/probe",
        Buffer.from(JSON.stringify({ name: "must-not-be-read" })),
        {},
      );

      expect(response.status).toBe(400);
      expect(response.json?.code).toBe(ApiErrorCode.INVALID_INPUT);
      expect(handled.count).toBe(0);
      expect(requestBodyRejections(metrics)).toEqual([
        { labels: { rejection: "missing_content_type" }, value: 1 },
      ]);
    });

    it("rejects duplicate Content-Type headers before parsing", async () => {
      const response = await postBytes(
        baseUrl,
        "/api/v1/probe",
        Buffer.from(JSON.stringify({ name: "must-not-be-read" })),
        {
          "content-type": [
            "application/json",
            "application/x-www-form-urlencoded",
          ],
        },
      );

      expect(response.status).toBe(400);
      expect(response.json?.code).toBe(ApiErrorCode.INVALID_INPUT);
      expect(handled.count).toBe(0);
      expect(requestBodyRejections(metrics)).toEqual([
        { labels: { rejection: "ambiguous_content_type" }, value: 1 },
      ]);
    });

    it.each([
      "/api/v1/credentials/verify",
      "/api/v1/security/csp-reports",
    ])("applies the route-specific JSON-only allowlist at %s", async (path) => {
      const response = await postBytes(
        baseUrl,
        path,
        Buffer.from("name=must-not-be-read"),
        { "content-type": "application/x-www-form-urlencoded" },
      );

      expect(response.status).toBe(400);
      expect(response.json?.code).toBe(ApiErrorCode.INVALID_INPUT);
      expect(handled.count).toBe(0);
      expect(requestBodyRejections(metrics)).toEqual([
        { labels: { rejection: "unsupported_content_type" }, value: 1 },
      ]);
    });
  });

  describe("structural limits", () => {
    it("refuses a body nested past the depth limit", async () => {
      const response = await postRaw(
        baseUrl,
        "/api/v1/probe",
        nestedJson(PAYLOAD_SHAPE_LIMITS.maxDepth + 5),
      );

      expect(response.status).toBe(413);
      expect(response.json?.code).toBe(ApiErrorCode.PAYLOAD_TOO_LARGE);
      expect(response.json?.message).toMatch(/nested deeper/);
      expect(handled.count).toBe(0);
    });

    it("refuses deep nesting without a stack overflow", async () => {
      // A thousand levels: deep enough that a recursive walk of the parsed body
      // is a real risk, and the answer must still be the client's 413 rather
      // than a RangeError surfacing as a 500.
      const response = await postRaw(baseUrl, "/api/v1/probe", nestedJson(1_000));

      expect(response.status).toBe(413);
      expect(response.json?.code).toBe(ApiErrorCode.PAYLOAD_TOO_LARGE);
    });

    it("refuses an array longer than the structural limit", async () => {
      const response = await postJson(baseUrl, "/api/v1/probe", {
        ids: Array(PAYLOAD_SHAPE_LIMITS.maxArrayItems + 1).fill("a"),
      });

      expect(response.status).toBe(413);
      expect(response.json?.message).toMatch(/array with more than/);
      expect(handled.count).toBe(0);
    });

    it("refuses a single string longer than the structural limit", async () => {
      const response = await postJson(baseUrl, "/api/v1/probe", {
        name: "z".repeat(PAYLOAD_SHAPE_LIMITS.maxStringLength + 1),
      });

      expect(response.status).toBe(413);
      expect(response.json?.message).toMatch(/string longer than/);
    });

    it("refuses a body with more values than the node limit", async () => {
      // Wide rather than deep or long: 25 arrays of 900 numbers. No single
      // array trips the item limit, and the whole body stays under the byte
      // limit, so the node count is the only thing that can refuse it.
      const chunk = Array(900).fill(1);
      const wide: Record<string, unknown> = {};
      for (let index = 0; index < 25; index += 1) wide[`k${index}`] = chunk;

      const response = await postJson(baseUrl, "/api/v1/probe", wide);

      expect(response.status).toBe(413);
      expect(response.json?.message).toMatch(/more than \d+ values/);
    });
  });

  describe("domain limits", () => {
    it("refuses an array over the DTO limit with a validation error", async () => {
      // Between the domain limit and the structural limit, so the caller gets
      // the domain's more useful answer rather than a flat refusal.
      const count = FIELD_LIMITS.paymentIdsPerProof + 1;
      expect(count).toBeLessThan(PAYLOAD_SHAPE_LIMITS.maxArrayItems);

      const response = await postJson(baseUrl, "/api/v1/probe", {
        ids: Array(count).fill("payment-1"),
      });

      expect(response.status).toBe(422);
      expect(response.json?.code).toBe(ApiErrorCode.VALIDATION_ERROR);
      expect(handled.count).toBe(0);
    });

    it("refuses an over-long string field with a validation error", async () => {
      const response = await postJson(baseUrl, "/api/v1/probe", {
        name: "n".repeat(FIELD_LIMITS.name + 1),
      });

      expect(response.status).toBe(422);
      expect(response.json?.code).toBe(ApiErrorCode.VALIDATION_ERROR);
      expect(handled.count).toBe(0);
    });

    it("accepts a request at the domain limit", async () => {
      // The limit has to be usable: an off-by-one that refuses the documented
      // maximum is a bug only the largest real caller ever hits.
      const response = await postJson(baseUrl, "/api/v1/probe", {
        ids: Array(FIELD_LIMITS.paymentIdsPerProof).fill("payment-1"),
      });

      expect(response.status).toBe(201);
      expect(handled.count).toBe(1);
    });
  });

  describe("after a burst of rejected requests", () => {
    it("still answers a normal request promptly", async () => {
      const oversized = bodyOfSize(GLOBAL_BODY_LIMIT_BYTES * 2);

      // Bounded and local: 40 rejected requests, about 5 MB in total. Enough to
      // show the rejections are cheap without turning the suite into a load
      // test.
      for (let index = 0; index < 40; index += 1) {
        const rejected = await postRaw(baseUrl, "/api/v1/probe", oversized);
        expect(rejected.status).toBe(413);
      }

      expect(handled.count).toBe(0);

      const started = Date.now();
      const response = await postJson(baseUrl, "/api/v1/probe", {
        ids: ["payment-1"],
      });

      expect(response.status).toBe(201);
      // Generous, because CI machines are noisy. This fails if the burst left
      // the event loop saturated or the process swapping, which is the failure
      // being watched for — not a latency regression.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(handled.count).toBe(1);
    });

    it("still answers after a burst of structurally hostile bodies", async () => {
      const deep = nestedJson(1_000);

      for (let index = 0; index < 20; index += 1) {
        const rejected = await postRaw(baseUrl, "/api/v1/probe", deep);
        expect(rejected.status).toBe(413);
      }

      const started = Date.now();
      const response = await postJson(baseUrl, "/api/v1/probe", { name: "ok" });

      expect(response.status).toBe(201);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});

describe("limit catalogue", () => {
  it("resolves the applicable body limit by longest matching prefix", () => {
    expect(bodyLimitForPath("/api/v1/proofs")).toBe(GLOBAL_BODY_LIMIT_BYTES);
    expect(bodyLimitForPath("/api/v1/auth/verify")).toBe(
      ROUTE_BODY_LIMITS.find((route) => route.prefix === "/api/v1/auth")?.bytes,
    );
    expect(bodyLimitForPath("/api/v1/credentials/verify")).toBe(
      ROUTE_BODY_LIMITS.find(
        (route) => route.prefix === "/api/v1/credentials/verify",
      )?.bytes,
    );
  });

  it("keeps every route limit at or below the global one", () => {
    // A route limit above the global one would be silently ineffective, and
    // would read as protection that is not there.
    for (const route of ROUTE_BODY_LIMITS) {
      expect(route.bytes).toBeLessThanOrEqual(GLOBAL_BODY_LIMIT_BYTES);
    }
  });

  it("keeps domain limits inside the structural limits", () => {
    // Otherwise a request within the domain's stated maximum is refused by the
    // transport, and the documented limit is a lie.
    expect(FIELD_LIMITS.paymentIdsPerProof).toBeLessThanOrEqual(
      PAYLOAD_SHAPE_LIMITS.maxArrayItems,
    );
    expect(FIELD_LIMITS.url).toBeLessThanOrEqual(
      PAYLOAD_SHAPE_LIMITS.maxStringLength,
    );
    expect(FIELD_LIMITS.metadataDepth).toBeLessThanOrEqual(
      PAYLOAD_SHAPE_LIMITS.maxDepth,
    );
  });
});
