import {
  createRedirectChainContext,
  validateRedirect,
  getRedirectMethod,
  statusCodeChangesMethod,
  isRedirectStatusCode,
  isSameOrigin,
  normalizeUrlForComparison,
  isRedirectResponse,
  getLocationHeader,
  MAX_REDIRECT_DEPTH,
} from "./webhook-redirect-policy";
import { SsrfBlockedError } from "./webhook-ssrf-guard";

// Mock the SSRF guard to test redirect policy in isolation
jest.mock("./webhook-ssrf-guard", () => {
  const actual = jest.requireActual("./webhook-ssrf-guard");
  return {
    ...actual,
    assertSafeWebhookDestination: jest.fn().mockResolvedValue(undefined),
  };
});

import { assertSafeWebhookDestination } from "./webhook-ssrf-guard";

const guardMock = assertSafeWebhookDestination as jest.MockedFunction<
  typeof assertSafeWebhookDestination
>;

describe("WebhookRedirectPolicy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createRedirectChainContext", () => {
    it("should initialize context with empty visited URLs and zero hops", () => {
      const context = createRedirectChainContext(
        "https://example.com/webhook",
        "POST",
        false,
      );

      expect(context.hopCount).toBe(0);
      expect(context.originalUrl).toBe("https://example.com/webhook");
      expect(context.originalMethod).toBe("POST");
      expect(context.hasOriginalCredentials).toBe(false);
      expect(context.visitedUrls.size).toBe(1);
      expect(context.visitedUrls.has("https://example.com/webhook")).toBe(true);
    });

    it("should track initial URL in visited set", () => {
      const context = createRedirectChainContext(
        "https://example.com/api",
        "POST",
        true,
      );

      expect(context.visitedUrls.has("https://example.com/api")).toBe(true);
    });
  });

  describe("validateRedirect", () => {
    describe("Positive cases: valid redirects", () => {
      it("should allow same-origin 301 redirect (POST->GET)", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          301,
          "https://example.com/webhook-new",
          context,
        );

        expect(result.decision).toBe("allowed");
        expect(result.methodWillChange).toBe(true);
        expect(context.hopCount).toBe(1);
        expect(context.visitedUrls.size).toBe(2);
      });

      it("should allow same-origin 307 redirect (POST preserved)", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          307,
          "https://example.com/v2/webhook",
          context,
        );

        expect(result.decision).toBe("allowed");
        expect(result.methodWillChange).toBe(false);
      });

      it("should allow same-origin 308 redirect (POST preserved)", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          308,
          "https://example.com/webhooks/v2",
          context,
        );

        expect(result.decision).toBe("allowed");
        expect(result.methodWillChange).toBe(false);
      });

      it("should allow 302 redirect with same origin", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          302,
          "https://example.com/webhook-updated",
          context,
        );

        expect(result.decision).toBe("allowed");
      });

      it("should allow 303 redirect with same origin", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          303,
          "https://example.com/api/webhook",
          context,
        );

        expect(result.decision).toBe("allowed");
      });

      it("should allow cross-origin redirect with 307 (preserves POST)", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          307,
          "https://other.com/webhook",
          context,
        );

        expect(result.decision).toBe("allowed");
        expect(result.methodWillChange).toBe(false);
      });

      it("should allow multiple redirects up to limit", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        for (let i = 0; i < MAX_REDIRECT_DEPTH; i++) {
          const result = await validateRedirect(
            307,
            `https://example.com/webhook${i}`,
            context,
          );
          expect(result.decision).toBe("allowed");
          expect(context.hopCount).toBe(i + 1);
        }
      });
    });

    describe("Negative cases: blocked redirects", () => {
      it("should reject redirect when depth limit exceeded", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        // Fill up the redirect limit
        for (let i = 0; i < MAX_REDIRECT_DEPTH; i++) {
          await validateRedirect(307, `https://example.com/webhook${i}`, context);
        }

        // Next redirect should be rejected
        const result = await validateRedirect(
          307,
          "https://example.com/webhook-final",
          context,
        );

        expect(result.decision).toBe("redirect_depth_exceeded");
        expect(result.rejectionReason).toBe("redirect_depth_exceeded");
      });

      it("should reject redirect loop (same URL visited twice)", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        // First redirect to /v2
        await validateRedirect(
          307,
          "https://example.com/webhook/v2",
          context,
        );

        // Try to redirect back to /v2 (loop)
        const result = await validateRedirect(
          307,
          "https://example.com/webhook/v2",
          context,
        );

        expect(result.decision).toBe("redirect_loop_detected");
        expect(result.rejectionReason).toBe("redirect_loop_detected");
      });

      it("should reject initial URL as loop target", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        // Try to redirect back to original URL
        const result = await validateRedirect(
          307,
          "https://example.com/webhook",
          context,
        );

        expect(result.decision).toBe("redirect_loop_detected");
      });

      it("should reject cross-origin redirect with method change", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        // 301 changes POST to GET, cross-origin is blocked for method change
        const result = await validateRedirect(
          301,
          "https://other.com/webhook",
          context,
        );

        expect(result.decision).toBe("cross_origin_redirect");
        expect(result.rejectionReason).toBe("cross_origin_redirect");
        expect(result.methodWillChange).toBe(true);
      });

      it("should reject cross-origin redirect with credentials", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          true, // has credentials
        );

        const result = await validateRedirect(
          307,
          "https://other.com/webhook",
          context,
        );

        expect(result.decision).toBe("cross_origin_redirect");
        expect(result.rejectionReason).toBe("cross_origin_redirect");
      });

      it("should reject redirect to SSRF-blocked destination", async () => {
        guardMock.mockRejectedValueOnce(
          new SsrfBlockedError("destination is private"),
        );

        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          307,
          "https://127.0.0.1/webhook",
          context,
        );

        expect(result.decision).toBe("destination_blocked");
        expect(result.rejectionReason).toBe("destination_blocked");
        expect(guardMock).toHaveBeenCalledWith("https://127.0.0.1/webhook");
      });

      it("should reject invalid redirect status code", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          200, // Not a redirect code
          "https://example.com/webhook",
          context,
        );

        expect(result.decision).toBe("invalid_redirect_code");
        expect(result.rejectionReason).toBe("invalid_redirect_code");
      });

      it("should reject redirect with missing Location header", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          301,
          undefined, // missing Location
          context,
        );

        expect(result.decision).toBe("invalid_redirect_code");
        expect(result.rejectionReason).toBe("invalid_redirect_code");
      });

      it("should reject redirect with empty Location header", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        const result = await validateRedirect(
          301,
          "", // empty Location
          context,
        );

        expect(result.decision).toBe("invalid_redirect_code");
      });
    });

    describe("Boundary cases", () => {
      it("should normalize URLs with fragments for loop detection", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook#ignored",
          "POST",
          false,
        );

        // Try to redirect to same URL with different fragment
        const result = await validateRedirect(
          307,
          "https://example.com/webhook#other",
          context,
        );

        // Should be detected as loop (fragments normalized away)
        expect(result.decision).toBe("redirect_loop_detected");
      });

      it("should handle query parameter ordering in loop detection", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook?a=1&b=2",
          "POST",
          false,
        );

        // Try to redirect to same URL with reordered query params
        const result = await validateRedirect(
          307,
          "https://example.com/webhook?b=2&a=1",
          context,
        );

        // Should be detected as loop (params normalized)
        expect(result.decision).toBe("redirect_loop_detected");
      });

      it("should handle case-insensitive hostname comparison", async () => {
        const context = createRedirectChainContext(
          "https://Example.com/webhook",
          "POST",
          false,
        );

        // Try to redirect to same host with different case
        const result = await validateRedirect(
          307,
          "https://EXAMPLE.COM/webhook",
          context,
        );

        // Should be detected as loop (hostnames are case-insensitive)
        expect(result.decision).toBe("redirect_loop_detected");
      });

      it("should increment hopCount on allowed redirect", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        expect(context.hopCount).toBe(0);

        const result = await validateRedirect(
          307,
          "https://example.com/v2",
          context,
        );

        expect(result.hopCount).toBe(1);
        expect(context.hopCount).toBe(1);
      });

      it("should not increment hopCount on rejected redirect", async () => {
        const context = createRedirectChainContext(
          "https://example.com/webhook",
          "POST",
          false,
        );

        // Fill up redirect limit
        for (let i = 0; i < MAX_REDIRECT_DEPTH; i++) {
          await validateRedirect(307, `https://example.com/v${i}`, context);
        }

        const hopCountBefore = context.hopCount;

        const result = await validateRedirect(
          307,
          "https://example.com/final",
          context,
        );

        expect(result.decision).toBe("redirect_depth_exceeded");
        expect(context.hopCount).toBe(hopCountBefore); // Not incremented
      });
    });
  });

  describe("getRedirectMethod", () => {
    it("should preserve POST for 307", () => {
      expect(getRedirectMethod(307, "POST")).toBe("POST");
    });

    it("should preserve POST for 308", () => {
      expect(getRedirectMethod(308, "POST")).toBe("POST");
    });

    it("should change POST to GET for 301", () => {
      expect(getRedirectMethod(301, "POST")).toBe("GET");
    });

    it("should change POST to GET for 302", () => {
      expect(getRedirectMethod(302, "POST")).toBe("GET");
    });

    it("should change POST to GET for 303", () => {
      expect(getRedirectMethod(303, "POST")).toBe("GET");
    });
  });

  describe("statusCodeChangesMethod", () => {
    it("should return true for 301", () => {
      expect(statusCodeChangesMethod(301)).toBe(true);
    });

    it("should return true for 302", () => {
      expect(statusCodeChangesMethod(302)).toBe(true);
    });

    it("should return true for 303", () => {
      expect(statusCodeChangesMethod(303)).toBe(true);
    });

    it("should return false for 307", () => {
      expect(statusCodeChangesMethod(307)).toBe(false);
    });

    it("should return false for 308", () => {
      expect(statusCodeChangesMethod(308)).toBe(false);
    });

    it("should return false for non-redirect codes", () => {
      expect(statusCodeChangesMethod(200)).toBe(false);
      expect(statusCodeChangesMethod(404)).toBe(false);
      expect(statusCodeChangesMethod(500)).toBe(false);
    });
  });

  describe("isRedirectStatusCode", () => {
    it("should return true for 301", () => {
      expect(isRedirectStatusCode(301)).toBe(true);
    });

    it("should return true for 302", () => {
      expect(isRedirectStatusCode(302)).toBe(true);
    });

    it("should return true for 303", () => {
      expect(isRedirectStatusCode(303)).toBe(true);
    });

    it("should return true for 307", () => {
      expect(isRedirectStatusCode(307)).toBe(true);
    });

    it("should return true for 308", () => {
      expect(isRedirectStatusCode(308)).toBe(true);
    });

    it("should return false for 2xx", () => {
      expect(isRedirectStatusCode(200)).toBe(false);
      expect(isRedirectStatusCode(201)).toBe(false);
    });

    it("should return false for 4xx", () => {
      expect(isRedirectStatusCode(400)).toBe(false);
      expect(isRedirectStatusCode(404)).toBe(false);
    });

    it("should return false for 5xx", () => {
      expect(isRedirectStatusCode(500)).toBe(false);
    });
  });

  describe("isSameOrigin", () => {
    it("should return true for identical origins", () => {
      const url1 = "https://example.com/webhook";
      const url2 = "https://example.com/v2/webhook";

      expect(isSameOrigin(url1, url2)).toBe(true);
    });

    it("should return true for same scheme/host/port, different path", () => {
      const url1 = "https://example.com:443/webhook";
      const url2 = "https://example.com:443/api/webhook";

      expect(isSameOrigin(url1, url2)).toBe(true);
    });

    it("should return false for different hosts", () => {
      const url1 = "https://example.com/webhook";
      const url2 = "https://other.com/webhook";

      expect(isSameOrigin(url1, url2)).toBe(false);
    });

    it("should return false for different schemes", () => {
      const url1 = "https://example.com/webhook";
      const url2 = "http://example.com/webhook";

      expect(isSameOrigin(url1, url2)).toBe(false);
    });

    it("should return false for different ports", () => {
      const url1 = "https://example.com:443/webhook";
      const url2 = "https://example.com:8443/webhook";

      expect(isSameOrigin(url1, url2)).toBe(false);
    });

    it("should treat default HTTPS port as implicit", () => {
      const url1 = "https://example.com/webhook";
      const url2 = "https://example.com:443/webhook";

      expect(isSameOrigin(url1, url2)).toBe(true);
    });

    it("should return false for invalid URLs", () => {
      expect(isSameOrigin("invalid", "https://example.com")).toBe(false);
      expect(isSameOrigin("https://example.com", "invalid")).toBe(false);
    });
  });

  describe("normalizeUrlForComparison", () => {
    it("should remove fragments", () => {
      const url1 = "https://example.com/webhook#section";
      const url2 = "https://example.com/webhook";

      expect(normalizeUrlForComparison(url1)).toBe(
        normalizeUrlForComparison(url2),
      );
    });

    it("should sort query parameters", () => {
      const url1 = "https://example.com/webhook?a=1&b=2";
      const url2 = "https://example.com/webhook?b=2&a=1";

      expect(normalizeUrlForComparison(url1)).toBe(
        normalizeUrlForComparison(url2),
      );
    });

    it("should be case-insensitive for hostname", () => {
      const url1 = "https://Example.com/webhook";
      const url2 = "https://example.com/webhook";

      expect(normalizeUrlForComparison(url1)).toBe(
        normalizeUrlForComparison(url2),
      );
    });

    it("should handle invalid URLs gracefully", () => {
      const result = normalizeUrlForComparison("invalid://[invalid");
      expect(typeof result).toBe("string");
    });

    it("should preserve path differences", () => {
      const url1 = "https://example.com/webhook";
      const url2 = "https://example.com/webhooks";

      expect(normalizeUrlForComparison(url1)).not.toBe(
        normalizeUrlForComparison(url2),
      );
    });
  });

  describe("isRedirectResponse", () => {
    it("should return true for 301 response", () => {
      const response = new Response("", { status: 301 });
      expect(isRedirectResponse(response)).toBe(true);
    });

    it("should return true for 307 response", () => {
      const response = new Response("", { status: 307 });
      expect(isRedirectResponse(response)).toBe(true);
    });

    it("should return false for 200 response", () => {
      const response = new Response("", { status: 200 });
      expect(isRedirectResponse(response)).toBe(false);
    });

    it("should return false for 404 response", () => {
      const response = new Response("", { status: 404 });
      expect(isRedirectResponse(response)).toBe(false);
    });
  });

  describe("getLocationHeader", () => {
    it("should return Location header value", () => {
      const response = new Response("", {
        status: 301,
        headers: { Location: "https://example.com/new" },
      });
      expect(getLocationHeader(response)).toBe("https://example.com/new");
    });

    it("should return undefined when Location header missing", () => {
      const response = new Response("", { status: 301 });
      expect(getLocationHeader(response)).toBeUndefined();
    });

    it("should be case-insensitive", () => {
      const response = new Response("", {
        status: 301,
        headers: { "location": "https://example.com/new" },
      });
      expect(getLocationHeader(response)).toBe("https://example.com/new");
    });
  });

  describe("Authorization and regression tests", () => {
    it("should prevent credential leakage across origins via redirects", async () => {
      const context = createRedirectChainContext(
        "https://api.example.com/webhook",
        "POST",
        true, // has credentials (e.g., Authorization header in original request)
      );

      // Try cross-origin redirect
      const result = await validateRedirect(
        307,
        "https://attacker.com/webhook",
        context,
      );

      expect(result.decision).toBe("cross_origin_redirect");
      expect(result.rejectionReason).toBe("cross_origin_redirect");
    });

    it("should prevent method downgrade across origins", async () => {
      const context = createRedirectChainContext(
        "https://api.example.com/webhook",
        "POST",
        false,
      );

      // Try cross-origin redirect with 302 (POST -> GET)
      const result = await validateRedirect(
        302,
        "https://other.com/webhook",
        context,
      );

      expect(result.decision).toBe("cross_origin_redirect");
    });

    it("should reject SSRF attacks via redirect chains", async () => {
      guardMock.mockRejectedValueOnce(new SsrfBlockedError("private IP"));

      const context = createRedirectChainContext(
        "https://example.com/webhook",
        "POST",
        false,
      );

      const result = await validateRedirect(
        307,
        "http://169.254.169.254/latest/meta-data/",
        context,
      );

      expect(result.decision).toBe("destination_blocked");
    });

    it("should maintain loop detection across multiple redirects", async () => {
      const context = createRedirectChainContext(
        "https://example.com/webhook",
        "POST",
        false,
      );

      // Chain of redirects
      await validateRedirect(
        307,
        "https://example.com/v1/webhook",
        context,
      );
      await validateRedirect(
        307,
        "https://example.com/v2/webhook",
        context,
      );

      // Try to loop back to v1
      const result = await validateRedirect(
        307,
        "https://example.com/v1/webhook",
        context,
      );

      expect(result.decision).toBe("redirect_loop_detected");
    });

    it("should preserve POST body across safe redirects", async () => {
      const context = createRedirectChainContext(
        "https://example.com/webhook",
        "POST",
        false,
      );

      // 307 preserves POST
      const result = await validateRedirect(
        307,
        "https://example.com/v2",
        context,
      );

      expect(result.decision).toBe("allowed");
      expect(result.methodWillChange).toBe(false);
    });
  });
});
