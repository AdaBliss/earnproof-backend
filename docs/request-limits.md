# Request limits

The largest request this service accepts, at each boundary, and why each number
is what it is.

Domain validation runs late. By the time a DTO is checked, the body has been
read off the socket, parsed into objects, and walked by class-transformer. A
request that is *validly shaped* but enormous — ten thousand payment ids, a
megabyte of metadata, an array nested five hundred deep — costs memory, CPU,
database work and log volume before a single domain rule has an opinion about
it. These limits are the earlier boundary.

Every value lives in
[`src/common/limits/request-limits.ts`](../src/common/limits/request-limits.ts),
which is what the application enforces and what the tests assert against.

## The three boundaries

| Boundary | Enforced by | Rejects with |
|---|---|---|
| **Transport** — compressed and expanded bytes | Compressed-body gate and `express.json` limits, in [`bootstrap.ts`](../src/bootstrap.ts) | `413 PAYLOAD_TOO_LARGE` |
| **Structure** — depth, array length, string length, node count | [`requestShapeMiddleware`](../src/common/middleware/request-shape.middleware.ts) | `413 PAYLOAD_TOO_LARGE` |
| **Domain** — what each field means | DTO decorators | `422 VALIDATION_ERROR` |

They run in that order, and the order is the design. Compressed bodies are
bounded before decompression; decoded bytes are bounded before JSON/form
parsing. Rejected bodies are never parsed, validated, logged as payloads, or
passed to a handler. The structural check is the first thing to look at a parsed
body, before guards do database work and before class-transformer walks it. Only
then does the domain get a say, and by then the input is small enough that being
wrong about it is cheap.

## Transport: body size

**Global: 64 KB.** Roughly forty times the largest legitimate request this API
has, and small enough that a thousand concurrent oversized requests cannot
exhaust a small container's memory.

Two routes are tighter, and none is looser:

| Route prefix | Limit | Why |
|---|---|---|
| `/api/v1/auth` | 8 KB | Unauthenticated, and therefore the cheapest place to attack. A challenge or verification carries an address, an id and a signature. |
| `/api/v1/credentials/verify` | 40 KB | The one endpoint that legitimately takes a document. Its DTO caps the credential at 32 KB, so a larger body cannot become a valid request. |

A test asserts no route limit exceeds the global one; a route limit above it
would be silently ineffective and would read as protection that is not there.

Compressed JSON and form bodies are bounded by the same route-specific limit
before decompression. Decoded output is bounded by the existing transport limit
and by a maximum `MAX_BODY_EXPANSION_RATIO` (100:1). Equality at each limit is
accepted.
Limit rejections increment `request_body_rejections_total{rejection}` with one of
`compressed_too_large`, `expanded_too_large`, or `expansion_ratio_exceeded`.
The closed reason vocabulary carries no request, route, or payload data.

## Structure

The byte limit alone does not bound the work a body creates. 64 KB of `[[[[[…`
is sixteen thousand levels deep and will overflow the stack in any recursive
walk — class-transformer's included — before validation reports anything. 64 KB
of `[1,1,1,…]` is twenty thousand array elements, each of which class-validator
will visit.

| Limit | Value | Bounds |
|---|---|---|
| `maxDepth` | 12 | Stack depth of every later walk. The deepest legitimate body is a credential envelope at five levels. |
| `maxArrayItems` | 1,000 | Per-array iteration. Above the largest domain limit, so a request refused here is refused for being abusive rather than for being large. |
| `maxStringLength` | 8 KB | The "one enormous field" shape. The longest legitimate string is a webhook URL at 2 KB. |
| `maxNodes` | 20,000 | Total validation cost, which is proportional to node count rather than to bytes. |

The check is a single iterative pass with no recursion — a recursive checker
would be the first thing to fail on the input it exists to reject, reporting a
stack overflow as a 500 rather than the hostile body as a 413. It stops at the
first violation and, regardless, at `maxNodes`, so the check itself can never
cost more than the limits allow.

Depth counts containers, not values: `{ "a": { "b": 1 } }` is two levels, the
way anyone describing the JSON would count it.

## Domain

Field limits are in `FIELD_LIMITS` and are used by the DTOs, so a DTO reads as a
statement about the domain and the number stays in one place.

| Limit | Value | Applies to |
|---|---|---|
| `id` | 64 | Every identifier field. A cuid is 25 characters. |
| `assetCode` | 12 | The Stellar maximum. |
| `decimalAmount` | 32 | Amount strings, before the decimal regex has to scan them. |
| `stellarAddress` | 56 | Exactly the length of a Stellar address. |
| `name` | 120 | Human-facing names: keys, organisations, display names. |
| `url` | 2 KB | Webhook and website URLs. |
| `paymentIdsPerProof` | 500 | Payment ids on a proof request. |
| `metadataBytes` / `metadataDepth` | 8 KB / 5 | Free-form metadata objects. |

`paymentIdsPerProof` is the one that was missing and matters most: without it,
one request could ask the database to load an unbounded number of payments and
decrypt every amount. A year of daily payments is 365, so 500 accepts every
realistic proof.

Domain limits sit *inside* the structural limits, and a test asserts it. If they
did not, a request within the documented domain maximum would be refused by the
transport, and the documented limit would be a lie.

## Error behaviour

Every rejection uses the standard `ApiErrorDto` envelope, with a request id, and
none of them quotes the payload. An error that echoes the body puts an oversized
— and possibly sensitive — payload into the response and the log, which is the
same resource-exhaustion problem one layer down and a privacy problem as well
when the body was a credential.

| Cause | Status | Code |
|---|---|---|
| Body over the transport limit | 413 | `PAYLOAD_TOO_LARGE` |
| Body over a structural limit | 413 | `PAYLOAD_TOO_LARGE` |
| Body that is not readable JSON | 400 | `INVALID_INPUT` |
| Field over a domain limit | 422 | `VALIDATION_ERROR`, with the field named |

Body-parser failures arrive as plain errors rather than as `HttpException`s, so
the global filter classifies them explicitly
([`global-exception.filter.ts`](../src/common/filters/global-exception.filter.ts)).
Without that, an oversized body would be reported as an internal error — telling
the client nothing actionable and logging a 500 for what is ordinary, expected
input.

## Tests

| Property | Test |
|---|---|
| Limits enforced end to end: oversized bodies, arrays, strings, nesting, node counts; per-route limits; error envelope; no payload echo; service still responsive after a burst of rejections | [`test/security/request-limits.spec.ts`](../test/security/request-limits.spec.ts) |
| The structural walker at its boundaries, including a 200,000-level body | [`src/common/limits/payload-shape.spec.ts`](../src/common/limits/payload-shape.spec.ts) |

The load fixtures are bounded and local: forty rejected 128 KB requests, then a
normal request that must still be answered promptly. Enough to show the
rejections are cheap without turning the unit suite into a load test.

## Changing a limit

Change it in `request-limits.ts` and nowhere else, update the table above, and
keep the invariants the tests assert: no route limit above the global one, and
no domain limit outside the structural limits.
