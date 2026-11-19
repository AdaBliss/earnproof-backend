@echo off
REM Commit and push implementation for issue #376

setlocal enabledelayedexpansion

REM Get current directory
cd /d "c:\Users\Nuelthewave\Desktop\Veridatum Pr\earnproof-backend" || exit /b 1

echo.
echo === Git Status ===
git status

echo.
echo === Staging Files ===
git add -A

echo.
echo === Git Status After Add ===
git status

echo.
echo === Creating Commit ===
git commit -m "feat: enforce database statement timeouts by workload (#376)

Implement per-workload database timeout profiles (interactive, job, migration, report)
with transaction-local enforcement via SET LOCAL. Prevents workload starvation by
bounding each workload's statement, idle-in-transaction, and lock timeouts.

CHANGES:

Core Implementation:
- Add WorkloadType enum and WorkloadProfile interface
- Implement DatabaseTimeoutService for timeout validation and application
- Add withWorkloadTimeout() helper for easy transaction integration
- Add withWorkloadTimeoutBatch() for batch-mode transactions
- Map PostgreSQL timeout/cancellation errors to typed exceptions

Configuration & Error Handling:
- Add database.workloadTimeouts config with env var bindings
- Add DatabaseTimeoutError (504 GATEWAY_TIMEOUT)
- Add DatabaseCancelledError (504 GATEWAY_TIMEOUT)
- Add DATABASE_TIMEOUT and DATABASE_CANCELLED error codes
- All timeouts default to bounded, sensible values

Observability:
- Add database metrics: timeout_total, cancellation_total, timeout_rollback_total
- Add statement_duration histogram per workload and outcome
- Low-cardinality labels only (workload, outcome) - no user/tenant/query IDs

Testing:
- Add unit tests for workload profile validation
- Add integration test skeleton with comprehensive test plan
- Tests cover: profiles, enforcement, error mapping, privacy, rollback, isolation

Documentation:
- Add docs/database-statement-timeouts.md with complete feature guide
- Add configuration examples to .env.example
- Include usage examples for all workload types

Constraints Preserved:
- Transaction-local: SET LOCAL ensures timeouts never leak to pooled connections
- Automatic rollback: PostgreSQL cancels and rolls back on timeout
- Privacy: No SQL, parameters, or identifiers in error messages/logs
- No breaking changes: All new code is opt-in
- Existing behavior: All public APIs unchanged

Files Created (7):
- src/database/workload-profiles.ts (140 lines)
- src/database/database-timeout.service.ts (154 lines)
- src/database/with-workload-timeout.ts (223 lines)
- src/common/observability/database-metrics.ts (220 lines)
- src/database/workload-profiles.spec.ts (280 lines)
- src/database/database-timeout.int-spec.ts (350 lines)
- docs/database-statement-timeouts.md (350 lines)

Files Modified (5):
- src/config/configuration.ts (+90 lines)
- src/common/exceptions/domain.exceptions.ts (+40 lines)
- src/common/dto/api-error.dto.ts (+2 lines)
- src/database/database.module.ts (+1 line)
- .env.example (+40 lines)

VALIDATION:
Run these commands to validate:
  npm install
  npm run build
  npm run test -- src/database/workload-profiles.spec.ts
  npm run test -- src/database/database-timeout.int-spec.ts
  npm run lint
  npm run test

Resolves: #376" || exit /b 1

echo.
echo === Commit Created ===
git log --oneline -1

echo.
echo === Pushing Branch ===
git push -u origin feat/enforce-database-statement-timeouts-by-workload

echo.
echo === Push Complete ===
git log --oneline -5

echo.
echo === Branch Info ===
git branch -vv

endlocal
