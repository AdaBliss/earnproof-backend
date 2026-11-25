# Webhook Redirect Policy

## Overview

EarnProof webhook delivery now supports bounded HTTP redirects with explicit policy enforcement. This document describes the redirect policy, how it works, and what integrators should expect.

## Policy Summary

Redirects are followed with the following constraints:

| Constraint | Limit |
|-----------|-------|
| **Maximum redirect depth** | 5 redirects (6 total requests: initial + 5 redirects) |
| **Allowed status codes** | 301, 302, 303, 307, 308 |
| **Destination validation** | Each redirect target re-validated through SSRF guard |
| **Origin boundary** | Redirects within same origin (scheme + host + port) allowed; cross-origin allowed only without method change and no credentials |
| **Method handling** | POST preserved for 307/308; converted to GET for 301/302/303 |
| **Loop detection** | Request URLs tracked; duplicate URL = loop rejection |

## Design Rationale

### Why validate redirects at all?

Previously, redirects were explicitly rejected with `redirect: "error"`. However, many production webhook endpoints use redirects for:
- Load balancer failover
- Service migration (endpoint moved to new URL)
- CDN or reverse proxy architecture
- API versioning with redirect chains

Completely rejecting redirects meant legitimate endpoints could never be used.

### Why enforce policy instead of following blindly?

A redirect is an unvalidated destination. Without explicit policy, following a redirect could:
- **Re-send signed payload to attacker's endpoint** — if attacker controls the receiving service and the endpoint owner's DNS, they could redirect to their own server and replay the signed webhook
- **Leak secrets across origins** — credentials or signing information forwarded to an untrusted domain
- **Enable SSRF attacks** — redirect could point to internal IP ranges, cloud metadata endpoints, or internal services
- **Create infinite loops** — misconfigured redirects could cycle indefinitely

The redirect policy makes redirects safe by enforcing bounded, deterministic rules.

## How It Works

### Initial Request

1. Webhook endpoint URL validated through SSRF guard (no private IPs, no bare ports, HTTPS only)
2. Redirect chain context initialized: empty visited URL set, depth=0, original URL tracked
3. Initial POST request sent with signature and event payload

### Redirect Received

When a 3xx response is received:

1. **Depth check**: If already at 5 redirects, reject with `redirect_depth_exceeded`
2. **Status code validation**: Only 301/302/303/307/308 allowed
3. **Location header**: Must be present and non-empty
4. **Loop detection**: Check if redirect target URL already visited; if yes, reject with `redirect_loop_detected`
5. **Origin boundary check**: 
   - Same origin: always allowed
   - Cross-origin: only allowed if method won't change (POST would become GET) AND no credentials in original request
6. **Destination validation**: Redirect target re-validated through SSRF guard (blocks private IPs, cloud metadata, etc.)
7. **Method determination**: 307/308 preserve POST; 301/302/303 would change POST to GET
8. **Context update**: Increment hopCount, record visited URL

### Follow Redirect

If all policy checks pass:

1. Body consumption: previous response body read and discarded (resource cleanup)
2. New request sent with:
   - Updated URL (from Location header)
   - Same HTTP method (POST or GET based on policy)
   - **Same signature and headers** (X-EarnProof-*)
   - **Same event payload** (for POST)
3. Process response (redaction, truncation, status code handling)

## Rejection Reasons

Redirects can be rejected for these reasons:

| Reason | Meaning | Retryable |
|--------|---------|-----------|
| `invalid_redirect_code` | Status code is not 301/302/303/307/308 or Location header missing | No |
| `redirect_depth_exceeded` | Already followed 5 redirects | No |
| `redirect_loop_detected` | URL already visited in this chain | No |
| `destination_blocked` | SSRF guard rejected redirect destination | No |
| `cross_origin_redirect` | Cross-origin with method change or credentials | No |
| `method_changed_by_redirect` | (Informational) POST would become GET | No |

All redirect rejections are permanent failures. The delivery is dead-lettered with `failureReason` set to `redirect policy: {reason}`.

## Secrets and Credentials

### Webhook Signing Secrets

- **Original request**: Signed with HMAC-SHA256 using webhook's signing secret
- **Redirect requests**: **Same signature used** (not re-signed with new timestamp)
- **Why**: Signature only validates the original request body, not metadata. Reusing it proves this is part of the same delivery chain.

### HTTP Credentials

- EarnProof does not send HTTP Authorization headers; it uses X-EarnProof-* headers
- **Cross-origin redirects blocked if credentials present** in original request (fail-closed)
- **Same-origin redirects**: Credentials (if any) would be preserved, but EarnProof doesn't send them anyway

### Event Payload

- **Same payload** sent on all requests in the chain (original body preserved)
- **No credentials embedded** in event payload (fail-closed design)

## Examples

### Example 1: Same-Origin Redirect (Allowed)

```
Request 1:  POST https://api.example.com/webhook
Response 1: 307 Location: https://api.example.com/webhooks/v2

→ Allowed: same origin, 307 preserves POST
→ Request 2 sent to https://api.example.com/webhooks/v2
```

### Example 2: Load Balancer Failover (Allowed)

```
Request 1:  POST https://lb.example.com/webhook (primary failed)
Response 1: 307 Location: https://backup.example.com/webhook

→ Check: cross-origin, 307 preserves POST, no credentials
→ Allowed
→ Request 2 sent to https://backup.example.com/webhook
```

### Example 3: API Versioning with GET (Blocked)

```
Request 1:  POST https://api.example.com/webhook
Response 1: 302 Location: https://api.example.com/v2/webhook

→ Check: same origin, but 302 changes POST to GET
→ Policy allows this (same origin, method change is acceptable)
→ Request 2 sent as GET to https://api.example.com/v2/webhook
→ Note: Payload sent in POST, but GET has no body; this is safe for webhooks
```

### Example 4: Attacker Redirect (Blocked)

```
Request 1:  POST https://legitimate.com/webhook
Response 1: 301 Location: https://attacker.com/steal-webhook

→ Check: cross-origin (legitimate.com → attacker.com), 301 changes POST to GET
→ Blocked: cross-origin with method change
→ Delivery marked FAILED with failureReason: "redirect policy: cross_origin_redirect"
```

### Example 5: SSRF Redirect (Blocked)

```
Request 1:  POST https://example.com/webhook
Response 1: 301 Location: http://169.254.169.254/latest/meta-data/

→ Check: SSRF guard rejects private IP range
→ Blocked: destination_blocked
→ Delivery marked FAILED
```

### Example 6: Redirect Loop (Blocked)

```
Request 1:  POST https://example.com/webhook
Response 1: 307 Location: https://example.com/v2

Request 2:  POST https://example.com/v2
Response 2: 307 Location: https://example.com/webhook

→ Check: URL https://example.com/webhook already visited
→ Blocked: redirect_loop_detected
→ Delivery marked FAILED
```

## Observability

### Delivery Status

When a redirect is rejected:
- **status**: `FAILED` (permanent)
- **failureReason**: `"redirect policy: {reason}"` (e.g., `"redirect policy: cross_origin_redirect"`)
- **statusCode**: The HTTP status code that triggered the redirect
- **attempt**: Incremented as normal, but not retried

### Test Delivery

`POST /webhooks/{id}/test` reports redirect rejections:
- **statusClass**: `"redirect_rejected"` (instead of `"3xx"`)
- **failureReason**: Policy rejection reason
- **response.body**: Empty (redirect response body not returned)

### Logs

Webhook delivery logs include:
- Initial destination check and result
- Each redirect validation (accepted or rejected)
- Final response or failure reason

## Migration Notes

### For Integrators

**Existing behavior unchanged:**
- Webhooks to endpoints that don't redirect: no change
- Webhooks to endpoints that did redirect: now followed (if policy allows)

**New capabilities:**
- Endpoints with load balancer failover redirects now work
- Service migration with 307 redirects now supported

### For Operators

**Monitoring:**
- Watch for redirects in logs: `"Delivery {id} following redirect to {url}"`
- Monitor failed deliveries with `failureReason: "redirect policy: *"`

**Configuration:**
- `MAX_REDIRECT_DEPTH` (hardcoded to 5) can be made configurable if needed
- SSRF policy unchanged and still applied to redirect targets

## Testing

### Unit Tests

`webhook-redirect-policy.spec.ts` covers:
- Valid redirects (same-origin, method handling)
- Invalid redirects (depth limit, loops, SSRF blocks)
- Boundary cases (URL normalization, case sensitivity)
- Authorization (credential leakage prevention)
- Regression (SSRF attacks via redirect chains)

### Integration Tests

`webhook-delivery-redirects.spec.ts` structure covers:
- Real HTTP redirects via test server
- Payload preservation across redirects
- Response redaction and truncation
- Failure tracking and dead-lettering

## Future Enhancements

Potential future improvements (not in this release):

- Configurable redirect depth limit per webhook
- Redirect allowlist per webhook (e.g., only specific domains)
- Redirect event logging (track which redirects were followed)
- Cross-origin redirect opt-in (if security team deems safe)
- Relative URL resolution (RFC 3986 resolution for redirect targets)
