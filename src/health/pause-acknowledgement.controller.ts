import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { PublicRoute } from "../common/decorators/authorization-policy.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import {
  DEFAULT_ACKNOWLEDGEMENT_PAGE,
  MAX_ACKNOWLEDGEMENT_PAGE,
  PauseAcknowledgementService,
  PauseAcknowledgementStatusDto,
} from "./pause-acknowledgement.service";

@ApiTags("health")
@PublicRoute()
@Controller("health/protocol-pause/:contractId/acknowledgements")
export class PauseAcknowledgementController {
  constructor(private readonly acknowledgements: PauseAcknowledgementService) {}

  @Get()
  @ApiOperation({
    summary: "Get emergency pause acknowledgement status for a contract",
    description:
      "Projects the indexed acknowledgement sequence, scope, actor roles, incident commitment and " +
      "consistency findings. Private incident content is never stored or returned, and an " +
      "acknowledgement never grants authority to unpause.",
  })
  @ApiQuery({ name: "network", required: false, example: "testnet" })
  @ApiQuery({
    name: "limit",
    required: false,
    description: `Acknowledgements to return, newest first. Default ${DEFAULT_ACKNOWLEDGEMENT_PAGE}, maximum ${MAX_ACKNOWLEDGEMENT_PAGE}.`,
  })
  @ApiResponse({ status: 200, description: "Acknowledgement status." })
  @ApiResponse({ status: 400, description: "Invalid query.", type: ApiErrorDto })
  getStatus(
    @Param("contractId") contractId: string,
    @Query("network") network = "testnet",
    @Query("limit") limit?: string,
  ): Promise<PauseAcknowledgementStatusDto> {
    const parsed =
      limit === undefined ? DEFAULT_ACKNOWLEDGEMENT_PAGE : Number(limit);
    return this.acknowledgements.getStatus(network, contractId, parsed);
  }
}
