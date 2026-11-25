# Prisma Query-Count Budgets

A list endpoint's query count must be a constant of its code, never a function of
the page size. The classic regression is an N+1: a loop that issues one extra
query per row of the page. It is invisible at page size 2 in review and a latency
incident at page size 100 in production.

This document defines the budget for each targeted list path and how the test
suite enforces it.

## What a "query" is

One Prisma client operation: `model.method(...)` (`findMany`, `count`, `groupBy`,
and so on) or a raw call (`$queryRaw`, `$executeRaw`). That is the unit an N+1
loop multiplies. It is counted at the client boundary rather than as SQL
statements because the number of SQL statements behind one operation depends on
Prisma's relation-load strategy, which would make a budget non-deterministic.
A nested `select`/`include` is one operation.

## Budgets

The authoritative values live in
[`QUERY_BUDGETS`](../src/common/observability/query-budget.ts). Each is the
maximum operations a single call may issue **for any page size**.

| Path | Budget | Operations |
|---|---|---|
| `OrganizationsService.listOrganizations` | 3 | `organization.findMany`, `organization.count`, one `issuer.groupBy` for the whole page (skipped for an empty page) |
| `IssuersService.listIssuers` | 2 | `issuer.findMany`, `issuer.count` |
| `IssuersService.listIssuersPublic` | 2 | `issuer.findMany`, `issuer.count` |
| `PaymentsService.listPayments` | 1 | `payment.findMany` |
| `ProofsService.listProofs` | 1 | `proof.findMany` |
| `ApiKeyService.listKeysForOrganization` | 1 | `apiKey.findMany` (scope assignments are a nested select) |
| `WebhooksService.listForOrg` | 1 | `webhook.findMany` |
| `WebhooksService.listDeliveries` | 2 | ownership check, `webhookDelivery.findMany` |

Changing a number is a review decision, not a way to make a failing test pass.
First ask why the path needs another query. If it genuinely does, the change to
`QUERY_BUDGETS` and the reason belong in the same pull request.

## Enforcement

[`query-budgets.list-endpoints.spec.ts`](../src/common/observability/query-budgets.list-endpoints.spec.ts)
runs each real service method against a mock Prisma client that honours `take`
the way a database would, at page sizes 1, 10 and 100. For every path it asserts:

- the count is within the documented budget, and
- the count is **identical** at all three page sizes (no growth with pagination).

The mock returns more rows as the page size grows, so an N+1 makes the count at
size 100 differ from the count at size 1 and fails the test with a message naming
the repeated operation, for example `issuer.count x100`.

The same file keeps authorization and tenant-isolation regressions next to the
counts: user and organization scoping of every query, no widening of the public
issuer list beyond `ACTIVE`, and no secret columns in API key and webhook
selects.

`listOrganizations` previously issued one `issuer.count` per organization. It now
issues a single grouped query for the page; the test restores the old behavior
and fails if it returns.

## Counting in tests

```ts
const counter = new QueryCounter();
const prisma = countingClient(mockOrRealClient, counter);
await service.listThings(prisma, { limit: 100 });
assertWithinBudget("organizations.list", counter);
```

`countingClient` counts model delegates, raw calls, and queries inside an
interactive `$transaction`.

## Runtime instrumentation

Off by default, in every environment including production. Setting
`QUERY_BUDGET_INSTRUMENTATION=true` patches the Prisma delegates so operations
made inside `runWithQueryCounter` are counted. With no active counter the
overhead is one `AsyncLocalStorage.getStore()` per operation; with the flag unset
nothing is installed at all.

Recorded labels are `model.method` names only, never arguments, filters or row
data. Operations on an interactive-transaction client are not counted by the
runtime patch (a transaction client is a different object); use `countingClient`
when a transaction must be included.

## Limitations

- Budgets are enforced by unit tests with a mocked client. They prove the code
  path issues a constant number of operations; they do not measure SQL
  statements or latency against a real database.
- Only the listed paths are covered. New list endpoints should add a budget and a
  test alongside them.
