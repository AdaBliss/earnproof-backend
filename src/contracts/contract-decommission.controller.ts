import { Controller, Get, HttpCode, HttpStatus, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ApiKeyScope } from "@prisma/client";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { RequireScopes } from "../common/decorators/require-scopes.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { ApiKeyGuard } from "../common/guards/api-key.guard";
import { ScopesGuard } from "../common/guards/scopes.guard";
import { API_KEY_AUTH_SCHEME } from "../common/swagger/security-schemes";
import {
  ContractDecommissionService,
  DecommissionPolicyDto,
} from "./contract-decommission.service";

/**
 * Authoritative action policy for a contract that is being replaced or retired.
 * Read-only: the policy is derived from indexed chain state and the clock, and
 * cannot be edited through the API.
 */
@ApiTags("contracts")
@ApiBearerAuth(API_KEY_AUTH_SCHEME)
@Controller("contracts/:network/:contractId/decommission")
export class ContractDecommissionController {
  constructor(private readonly decommission: ContractDecommissionService) {}

  @ApiOperation({
    summary: "Get the decommission and grace-period action policy for a contract",
    description:
      "Returns grace boundaries, successor identity, terminal state and a per-capability " +
      "allow or deny decision. An elapsed grace period, unknown contract or stale projection " +
      "denies every mutating capability.",
  })
  @ApiResponse({ status: HttpStatus.OK, description: "Action policy." })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Missing or invalid API key.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "API key lacks the ORG_READ scope.",
    type: ApiErrorDto,
  })
  @Get()
  @AuthenticatedRoute({ roles: ["ORG_READ"] })
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard, ScopesGuard)
  @RequireScopes(ApiKeyScope.ORG_READ)
  getPolicy(
    @Param("network") network: string,
    @Param("contractId") contractId: string,
  ): Promise<DecommissionPolicyDto> {
    return this.decommission.getPolicy(network, contractId);
  }
}
