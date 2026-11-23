/**
 * DatabasePoolController
 *
 * Exposes the bounded database connection-pool saturation snapshot for
 * operators.
 *
 * Authorization:
 *  - GET /metrics/database/pool → ADMIN role (session auth, same as the
 *    other operations metrics endpoints).
 *
 * Tenant safety:
 *  - Only aggregate counts, ratios, latencies, thresholds, and a runbook
 *    link are returned. No connection string, credential, host, database
 *    name, or query text is ever present in the snapshot.
 */

import { Controller, Get, HttpCode, HttpStatus, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import {
  DatabasePoolMonitorService,
  DatabasePoolSnapshot,
} from "../health/database-pool-monitor.service";

@ApiTags("metrics")
@ApiBearerAuth()
@UseGuards(AuthGuard, RoleGuard)
@RequiredRole("ADMIN")
@Controller("metrics/database")
export class DatabasePoolController {
  constructor(private readonly pool: DatabasePoolMonitorService) {}

  @ApiOperation({
    summary: "Get database connection-pool saturation",
    description:
      "Returns bounded pool metrics (occupancy, wait latency, timeout " +
      "counts), thresholds, hysteresis state, and the runbook link. Only " +
      "aggregate numbers — no credentials, hosts, or query text.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Current database pool saturation snapshot.",
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Missing or invalid session.",
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Caller lacks the ADMIN role.",
  })
  @HttpCode(HttpStatus.OK)
  @Get("pool")
  async getPool(): Promise<DatabasePoolSnapshot> {
    return this.pool.sample();
  }
}
