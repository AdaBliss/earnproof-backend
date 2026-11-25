# Database Statement Timeouts by Workload

## Overview

Database statement timeouts enforce separate execution budgets for different workload types, preventing one workload from starving another. Interactive requests, background jobs, migrations, and reports each have their own timeout profile.

**Key properties:**
- Transaction-local enforcement via `SET LOCAL` (never leaks to pooled connections)
- Automatic rollback on timeout with no partial state
- Typed error mapping (no SQL, parameters, or internal details in responses)
- Metrics per workload for observability
- Fail-closed configuration (missing or invalid → bounded default, never "no timeout")

---

## Workload Types & Timeouts

| Workload | Use Case | Statement Timeout | Idle-in-Transaction | Lock Timeout |
|----------|----------|-------------------|---------------------|--------------|
| **INTERACTIVE** | HTTP request handlers, user-facing | 10s (10,000ms) | 30s | 5s |
| **JOB** | Background jobs, batch reconciliation | 120s (120,000ms) | 300s | 30s |
| **MIGRATION** | One-time deployments, schema changes | 3600s (1 hour) | 3600s | 300s |
| **REPORT** | Bulk exports, batch analytics | 600s (10 min) | 900s | 60s |

### Timeout Types

**statement_timeout**
- Applies to each individual SQL statement
- PostgreSQL cancels the statement when exceeded
- Transaction rolls back automatically
- Use case: Prevent runaway queries (e.g., missing indexes, complex joins)

**idle_in_transaction_session_timeout**
- Applies to transactions holding locks without progress
- PostgreSQL cancels the transaction when idle time exceeds the limit
- Prevents "lock camping" where a transaction acquires locks but makes no progress
- Use case: Prevent deadlock chains, detect stalled transactions

**lock_timeout**
- Applies to lock acquisition waits
- PostgreSQL fails the statement when the timeout is exceeded
- Does not cancel the transaction (caller can retry or abandon)
- Use case: Detect contention, fail fast instead of blocking

---

## Configuration

All timeout settings are environment variables, defaulting to sensible bounded values.

```bash
# INTERACTIVE workload (HTTP handlers)
DATABASE_TIMEOUT_INTERACTIVE_STATEMENT_MS=10000  # 10 seconds
DATABASE_TIMEOUT_INTERACTIVE_IDLE_MS=30000       # 30 seconds
DATABASE_TIMEOUT_INTERACTIVE_LOCK_MS=5000        # 5 seconds

# JOB workload (background jobs)
DATABASE_TIMEOUT_JOB_STATEMENT_MS=120000         # 120 seconds
DATABASE_TIMEOUT_JOB_IDLE_MS=300000              # 300 seconds
DATABASE_TIMEOUT_JOB_LOCK_MS=30000               # 30 seconds

# MIGRATION workload (deployments)
DATABASE_TIMEOUT_MIGRATION_STATEMENT_MS=3600000  # 1 hour
DATABASE_TIMEOUT_MIGRATION_IDLE_MS=3600000       # 1 hour
DATABASE_TIMEOUT_MIGRATION_LOCK_MS=300000        # 5 minutes

# REPORT workload (bulk operations)
DATABASE_TIMEOUT_REPORT_STATEMENT_MS=600000      # 10 minutes
DATABASE_TIMEOUT_REPORT_IDLE_MS=900000           # 15 minutes
DATABASE_TIMEOUT_REPORT_LOCK_MS=60000            # 1 minute
```

### Configuration Validation

- **Fail-closed:** Missing or invalid timeouts → use bounded defaults (never "no timeout")
- **Positive integers only:** Zero, negative, or non-integer values are rejected at startup
- **Per-workload:** Each workload has independent budgets (changing one does not affect others)
- **No secret rotation needed:** Timeouts are operational tuning, not secrets

---

## Usage

### Interactive Requests (HTTP Handlers)

```typescript
import { Injectable } from "@nestjs/common";
import { PrismaService } from "src/database/prisma.service";
import { DatabaseTimeoutService } from "src/database/database-timeout.service";
import { withWorkloadTimeout } from "src/database/with-workload-timeout";
import { WorkloadType } from "src/database/workload-profiles";

@Injectable()
export class ProofsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly databaseTimeout: DatabaseTimeoutService,
  ) {}

  async createProof(data: CreateProofDto): Promise<Proof> {
    // Automatically applies interactive timeout (10s statement, 30s idle, 5s lock)
    return withWorkloadTimeout(
      this.prisma,
      this.databaseTimeout,
      WorkloadType.INTERACTIVE,
      async (tx) => {
        // Write inside the transaction with interactive timeout active
        const proof = await tx.proof.create({
          data: {
            organizationId: data.organizationId,
            // ... proof fields
          },
        });

        // Create audit log
        await tx.auditLog.create({
          data: {
            organizationId: data.organizationId,
            action: "proof_created",
            resourceType: "Proof",
            resourceId: proof.id,
            // ...
          },
        });

        return proof;
      },
    );
  }
}
```

### Background Jobs

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { withWorkloadTimeout } from "src/database/with-workload-timeout";
import { WorkloadType } from "src/database/workload-profiles";

@Injectable()
export class AnchoringReconcilerService {
  private readonly logger = new Logger(AnchoringReconcilerService.name);

  async reconcile(): Promise<void> {
    // Background jobs get 120s statement, 300s idle timeout
    await withWorkloadTimeout(
      this.prisma,
      this.databaseTimeout,
      WorkloadType.JOB,
      async (tx) => {
        const stale = await tx.anchoringIntent.findMany({
          where: { status: "PENDING" },
          take: 100,
        });

        for (const intent of stale) {
          // Check Stellar, update database...
          await tx.anchoringIntent.update({
            where: { id: intent.id },
            data: { status: "CONFIRMED" },
          });
        }
      },
    );
  }
}
```

### Batch Transactions

For batch-mode transactions (multiple independent statements):

```typescript
const results = await withWorkloadTimeoutBatch(
  this.prisma,
  this.databaseTimeout,
  WorkloadType.JOB,
  [
    this.prisma.proof.update({...}),
    this.prisma.auditLog.create({...}),
    this.prisma.anchoringIntent.update({...}),
  ],
);
```

---

## Error Handling

### DatabaseTimeoutError

Raised when a statement or transaction exceeds its configured timeout.

```typescript
import {
  DatabaseTimeoutError,
  DatabaseCancelledError,
} from "src/common/exceptions/domain.exceptions";

try {
  await withWorkloadTimeout(...);
} catch (error) {
  if (error instanceof DatabaseTimeoutError) {
    // Timeout occurred — transaction was rolled back
    // Safe to retry
    logger.warn("Query timed out, retrying...");
    // Implement retry logic
  } else if (error instanceof DatabaseCancelledError) {
    // Explicit cancellation (admin action)
    // Different handling may apply
    logger.error("Query was cancelled by admin");
  } else {
    throw error;
  }
}
```

### Error Response

```json
{
  "statusCode": 504,
  "code": "DATABASE_TIMEOUT",
  "message": "Database operation timed out",
  "requestId": "01hwzxyz..."
}
```

**Privacy guarantees:**
- No SQL text, parameters, or query details
- No table names, column names, or schema information
- No user identifiers, tenant IDs, or organization IDs
- Safe to log and expose to clients

---

## Metrics

Metrics are emitted with low-cardinality labels (`workload`, `outcome`) to prevent series explosions.

### Available Metrics

- `database_timeout_total` (counter, by workload)
- `database_cancellation_total` (counter, by workload)
- `database_timeout_rollback_total` (counter, by workload)
- `database_idle_in_transaction_timeout_total` (counter, by workload)
- `database_lock_timeout_total` (counter, by workload)
- `database_statement_duration_ms` (histogram, by workload + outcome)

### Example Observability

```
# Timeouts by workload
database_timeout_total{workload="interactive"} 2
database_timeout_total{workload="job"} 0
database_timeout_total{workload="migration"} 0
database_timeout_total{workload="report"} 1

# Statement durations (histogram)
database_statement_duration_ms_bucket{workload="interactive",outcome="success",le="1000"} 5432
database_statement_duration_ms_bucket{workload="interactive",outcome="timeout",le="10000"} 2
database_statement_duration_ms_sum{workload="interactive",outcome="success"} 1234567
database_statement_duration_ms_count{workload="interactive",outcome="success"} 5432
```

---

## Audit Log & Lease Acquisition

### Audit Chain Writes

The audit chain write interception (`installAuditChainWriter()` in `PrismaService`) wraps every `auditLog.create()` call in an internal transaction for atomicity with chain cursor updates. Timeout handling ensures this internal transaction respects the parent transaction's timeout scope without cascading cancellations.

**Pattern:**
```typescript
// User's transaction with interactive timeout
await withWorkloadTimeout(..., WorkloadType.INTERACTIVE, async (tx) => {
  // Inside: audit.create internally opens $transaction
  // The inner transaction inherits the outer timeout scope (no new timeout needed)
  await tx.auditLog.create({ ... });
});
```

### Migration Lease

Migration lease acquisition (`MigrationLeaseService.acquireLease()`) uses advisory locks inside transactions. Timeout enforcement ensures lease operations complete within the migration timeout budget (3600s), and cancellation is clean (lock is released, lease row is not updated).

---

## Troubleshooting

### Timeout Too Aggressive

If a legitimate workload consistently times out:

1. Check the workload type assignment (is it interactive or job?)
2. Monitor `database_statement_duration_ms` histogram to see actual durations
3. Increase the relevant timeout in `.env` and re-deploy
4. Consider query optimization (missing indexes, N+1 queries, etc.)

### Timeout Too Lenient

If timeouts are not catching runaway queries:

1. Check that timeouts are configured (not defaulting by mistake)
2. Verify the workload type is correctly assigned
3. Lower the timeout to catch actual problems earlier
4. Add query analysis (EXPLAIN ANALYZE) to identify slow queries

### Lock Contention

If lock timeouts are frequent:

1. Check for concurrent writers to the same rows
2. Consider transaction ordering (always acquire locks in the same order)
3. Reduce transaction duration (batch work into smaller units)
4. Monitor `database_lock_timeout_total` to see contention

### Idle-in-Transaction Timeouts

If idle timeouts are firing unexpectedly:

1. Check for long-running transactions that hold locks between statements
2. Commit small transactions early (don't batch unnecessarily)
3. Increase the idle timeout if the workload requires extended lock holding

---

## Testing

### Unit Tests

Validate timeout configuration and profile validation:

```bash
npm run test -- src/database/workload-profiles.spec.ts
```

### Integration Tests

Test actual timeout behavior with synthetic data:

```bash
npm run test:integration -- --testNamePattern="database timeout"
```

### Manual Testing

1. Set `DATABASE_TIMEOUT_INTERACTIVE_STATEMENT_MS=1000` (1 second)
2. Run a slow query: `SELECT pg_sleep(5); -- 5 second sleep`
3. Observe `DatabaseTimeoutError` within 1 second
4. Verify transaction is rolled back (no partial writes)

---

## Further Reading

- **PostgreSQL timeout documentation:** https://www.postgresql.org/docs/current/runtime-config-client.html
- **Prisma transactions:** https://www.prisma.io/docs/orm/prisma-client/queries/transactions
- **Database design:** [docs/database-performance.md](./database-performance.md)
- **Observability:** [docs/observability.md](./observability.md)
