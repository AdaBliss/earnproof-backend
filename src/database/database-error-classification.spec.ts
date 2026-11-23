import { Prisma } from "@prisma/client";
import { ForbiddenException } from "@nestjs/common";
import { classifyDatabaseError } from "./database-error-classification";

/** Builds a Prisma known-request error with the given code and message. */
function prismaKnown(code: string, message = "prisma error", meta?: unknown) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "6.0.0",
    ...(meta !== undefined ? { meta: meta as never } : {}),
  });
}

describe("classifyDatabaseError", () => {
  // ── Positive: transient failures are retryable ─────────────────────────

  describe("retryable failures", () => {
    it("classifies P2034 with a deadlock message as a retryable deadlock", () => {
      const result = classifyDatabaseError(
        prismaKnown(
          "P2034",
          "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
        ),
      );
      expect(result).toEqual({
        retryable: true,
        category: "deadlock",
        prismaCode: "P2034",
      });
    });

    it("classifies P2034 without a deadlock mention as a retryable serialisation failure", () => {
      const result = classifyDatabaseError(
        prismaKnown("P2034", "Transaction failed due to a write conflict."),
      );
      expect(result.retryable).toBe(true);
      expect(result.category).toBe("serialization_failure");
    });

    it("classifies P2024 (pool timeout) as retryable", () => {
      expect(classifyDatabaseError(prismaKnown("P2024"))).toMatchObject({
        retryable: true,
        category: "pool_timeout",
      });
    });

    it.each(["P1001", "P1002", "P1008", "P1017"])(
      "classifies %s (connection loss) as a retryable connection failure",
      (code) => {
        expect(classifyDatabaseError(prismaKnown(code))).toMatchObject({
          retryable: true,
          category: "connection",
        });
      },
    );

    it("classifies a raw 40P01 SQLSTATE as a retryable deadlock", () => {
      expect(
        classifyDatabaseError(Object.assign(new Error("deadlock detected"), { code: "40P01" })),
      ).toEqual({ retryable: true, category: "deadlock", sqlState: "40P01" });
    });

    it.each([
      ["40001", "serialization_failure"],
      ["55P03", "lock_timeout"],
      ["53300", "connection"],
      ["08006", "connection"],
    ] as const)(
      "classifies raw SQLSTATE %s as retryable (%s)",
      (sqlState, category) => {
        expect(
          classifyDatabaseError(Object.assign(new Error("db error"), { code: sqlState })),
        ).toEqual({ retryable: true, category, sqlState });
      },
    );

    it("recovers the SQLSTATE from a P2010 raw-query failure message", () => {
      const error = prismaKnown(
        "P2010",
        "Raw query failed. Code: `40P01`. Message: `deadlock detected`",
        { code: "40P01", message: "deadlock detected" },
      );
      expect(classifyDatabaseError(error)).toMatchObject({
        retryable: true,
        category: "deadlock",
        prismaCode: "P2010",
        sqlState: "40P01",
      });
    });

    it("recovers the SQLSTATE from P2010 meta when the message has none", () => {
      const error = prismaKnown("P2010", "Raw query failed.", {
        code: "40001",
        message: "could not serialize access",
      });
      expect(classifyDatabaseError(error)).toMatchObject({
        retryable: true,
        category: "serialization_failure",
        sqlState: "40001",
      });
    });
  });

  // ── Negative: data errors and application errors are not retryable ─────

  describe("non-retryable failures", () => {
    it.each([
      ["P2002", "conflict"],
      ["P2003", "conflict"],
      ["P2025", "not_found"],
    ] as const)("classifies %s as non-retryable (%s)", (code, category) => {
      expect(classifyDatabaseError(prismaKnown(code))).toEqual({
        retryable: false,
        category,
        prismaCode: code,
      });
    });

    it("does not retry an authentication failure (P1000)", () => {
      expect(classifyDatabaseError(prismaKnown("P1000"))).toMatchObject({
        retryable: false,
      });
    });

    it("does not retry an access-denied failure (P1010)", () => {
      expect(classifyDatabaseError(prismaKnown("P1010"))).toMatchObject({
        retryable: false,
      });
    });

    it("does not retry an authorisation failure thrown inside a transaction", () => {
      expect(classifyDatabaseError(new ForbiddenException())).toEqual({
        retryable: false,
        category: "unknown",
      });
    });

    it("does not retry a Prisma validation error (programmer error)", () => {
      expect(
        classifyDatabaseError(
          new Prisma.PrismaClientValidationError("Invalid argument", {
            clientVersion: "6.0.0",
          }),
        ),
      ).toEqual({ retryable: false, category: "unknown" });
    });

    it("does not retry an unknown Prisma code", () => {
      expect(classifyDatabaseError(prismaKnown("P2999"))).toEqual({
        retryable: false,
        category: "unknown",
        prismaCode: "P2999",
      });
    });

    it("does not retry an unrecognised SQLSTATE", () => {
      expect(
        classifyDatabaseError(Object.assign(new Error("weird"), { code: "XX000" })),
      ).toEqual({ retryable: false, category: "unknown", sqlState: "XX000" });
    });
  });

  // ── Boundary: malformed and non-error values ───────────────────────────

  describe("boundary values", () => {
    it.each([undefined, null, 0, "deadlock", true])(
      "classifies non-object input %p as unknown and non-retryable",
      (value) => {
        expect(classifyDatabaseError(value)).toEqual({
          retryable: false,
          category: "unknown",
        });
      },
    );

    it("treats an error without a code as unknown", () => {
      expect(classifyDatabaseError(new Error("something broke"))).toEqual({
        retryable: false,
        category: "unknown",
      });
    });

    it("ignores a non-string code", () => {
      expect(
        classifyDatabaseError(Object.assign(new Error("x"), { code: 40001 })),
      ).toEqual({ retryable: false, category: "unknown" });
    });

    it("is case-sensitive on Prisma codes: lowercase p2034 is unknown", () => {
      expect(classifyDatabaseError(prismaKnown("p2034"))).toMatchObject({
        retryable: false,
        category: "unknown",
      });
    });

    it("classifies a plain error whose message carries a real SQLSTATE token", () => {
      // The message scan exists for driver errors that surface the SQLSTATE
      // only as text. It matches the full five-character token shape, so a
      // bare row count such as "40001" in prose is indistinguishable from
      // the SQLSTATE by design — the scan is a heuristic, and the category
      // it produces is diagnostic only.
      expect(
        classifyDatabaseError(new Error("query failed: 40P01 deadlock detected")),
      ).toEqual({ retryable: true, category: "deadlock", sqlState: "40P01" });
    });
  });
});
