import { DnsPinningService, DnsPinningRecord } from "./dns-pinning.service";

describe("DnsPinningService", () => {
  let service: DnsPinningService;

  beforeEach(() => {
    service = new DnsPinningService();
  });

  describe("resolveAndPin", () => {
    describe("IP literals", () => {
      it("accepts a valid public IPv4 literal without DNS lookup", async () => {
        const result = await service.resolveAndPin("93.184.216.34");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.record.resolvedAddress).toBe("93.184.216.34");
          expect(result.record.resolutionDurationMs).toBe(0);
          expect(result.record.ttlSeconds).toBe(0);
        }
      });

      it("accepts a valid public IPv6 literal without DNS lookup", async () => {
        const result = await service.resolveAndPin("2606:2800:220:1:248:1893:25c8:1946");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.record.resolvedAddress).toBe("2606:2800:220:1:248:1893:25c8:1946");
        }
      });

      it("rejects a loopback IPv4 literal", async () => {
        const result = await service.resolveAndPin("127.0.0.1");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("BLOCKED_IP_LITERAL");
          expect(result.error.transient).toBe(false);
        }
      });

      it("rejects a private IPv4 literal (RFC-1918)", async () => {
        const result = await service.resolveAndPin("192.168.1.1");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("BLOCKED_IP_LITERAL");
        }
      });

      it("rejects a link-local IPv6 literal", async () => {
        const result = await service.resolveAndPin("fe80::1");
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("BLOCKED_IP_LITERAL");
        }
      });
    });

    describe("hostname resolution", () => {
      it("resolves a hostname to a public address", async () => {
        const mockResolve = jest.fn(async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
        ]);

        const result = await service.resolveAndPin("example.com", mockResolve);
        expect(result.success).toBe(true);
        expect(mockResolve).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });

        if (result.success) {
          expect(result.record.resolvedAddress).toBe("93.184.216.34");
          expect(result.record.allResolvedAddresses).toEqual([
            "93.184.216.34",
            "2606:2800:220:1:248:1893:25c8:1946",
          ]);
          expect(result.record.resolutionDurationMs).toBeGreaterThanOrEqual(0);
        }
      });

      it("rejects hostname resolution that returns no addresses", async () => {
        const mockResolve = jest.fn(async () => []);

        const result = await service.resolveAndPin("nowhere.invalid", mockResolve);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("NO_ADDRESSES");
          expect(result.error.transient).toBe(true);
        }
      });

      it("rejects hostname resolution that returns a private address", async () => {
        const mockResolve = jest.fn(async () => [
          { address: "10.0.0.1", family: 4 },
        ]);

        const result = await service.resolveAndPin("internal.local", mockResolve);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("BLOCKED_DESTINATION");
          expect(result.error.transient).toBe(false);
        }
      });

      it("classifies DNS lookup errors as transient or permanent", async () => {
        // Transient error: ENOTFOUND (resolver issue, not found, temporary)
        const transientResolve = jest.fn(async () => {
          const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
          throw err;
        });

        const transientResult = await service.resolveAndPin("temp.invalid", transientResolve);
        expect(transientResult.success).toBe(false);
        if (!transientResult.success) {
          expect(transientResult.error.transient).toBe(true);
        }

        // Permanent error: invalid input
        const permanentResolve = jest.fn(async () => {
          const err = Object.assign(new Error("bad input"), { code: "EINVAL" });
          throw err;
        });

        const permanentResult = await service.resolveAndPin("host", permanentResolve);
        expect(permanentResult.success).toBe(false);
        if (!permanentResult.success) {
          expect(permanentResult.error.transient).toBe(false);
        }
      });

      it("selects the first address when multiple are available", async () => {
        const mockResolve = jest.fn(async () => [
          { address: "198.51.100.1", family: 4 },
          { address: "198.51.100.2", family: 4 },
          { address: "198.51.100.3", family: 4 },
        ]);

        const result = await service.resolveAndPin("multi.example", mockResolve);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.record.resolvedAddress).toBe("198.51.100.1");
          expect(result.record.allResolvedAddresses.length).toBe(3);
        }
      });
    });

    describe("error handling", () => {
      it("handles resolver throwing without a code", async () => {
        const mockResolve = jest.fn(async () => {
          throw new Error("unexpected error");
        });

        const result = await service.resolveAndPin("example.com", mockResolve);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("UNKNOWN");
        }
      });

      it("records resolution duration", async () => {
        const mockResolve = jest.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return [{ address: "93.184.216.34", family: 4 }];
        });

        const result = await service.resolveAndPin("example.com", mockResolve);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.record.resolutionDurationMs).toBeGreaterThanOrEqual(10);
        }
      });
    });
  });

  describe("shouldReResolve", () => {
    it("returns true when TTL has expired", () => {
      const record: DnsPinningRecord = {
        resolvedAddress: "93.184.216.34",
        resolvedAtMs: Date.now() - 10_000, // 10 seconds ago
        ttlSeconds: 5,
        allResolvedAddresses: ["93.184.216.34"],
        resolutionDurationMs: 50,
      };

      expect(service.shouldReResolve(record)).toBe(true);
    });

    it("returns false when TTL has not expired", () => {
      const record: DnsPinningRecord = {
        resolvedAddress: "93.184.216.34",
        resolvedAtMs: Date.now() - 2_000, // 2 seconds ago
        ttlSeconds: 5,
        allResolvedAddresses: ["93.184.216.34"],
        resolutionDurationMs: 50,
      };

      expect(service.shouldReResolve(record)).toBe(false);
    });

    it("returns true when TTL is unknown (sentinel 0)", () => {
      const record: DnsPinningRecord = {
        resolvedAddress: "93.184.216.34",
        resolvedAtMs: Date.now() - 1_000,
        ttlSeconds: 0, // Unknown TTL
        allResolvedAddresses: ["93.184.216.34"],
        resolutionDurationMs: 50,
      };

      expect(service.shouldReResolve(record)).toBe(true);
    });

    it("uses override TTL when provided", () => {
      const record: DnsPinningRecord = {
        resolvedAddress: "93.184.216.34",
        resolvedAtMs: Date.now() - 10_000, // 10 seconds ago
        ttlSeconds: 5, // Record says 5 seconds
        allResolvedAddresses: ["93.184.216.34"],
        resolutionDurationMs: 50,
      };

      // Override with longer TTL
      expect(service.shouldReResolve(record, 300)).toBe(false);

      // Override with shorter TTL
      expect(service.shouldReResolve(record, 3)).toBe(true);
    });

    it("correctly handles boundary case (age equals TTL)", () => {
      const now = Date.now();
      const record: DnsPinningRecord = {
        resolvedAddress: "93.184.216.34",
        resolvedAtMs: now - 5_000, // Exactly 5 seconds ago
        ttlSeconds: 5,
        allResolvedAddresses: ["93.184.216.34"],
        resolutionDurationMs: 50,
      };

      // At exact TTL boundary, should be considered expired
      expect(service.shouldReResolve(record)).toBe(true);
    });
  });
});
