import { Controller, Get, HttpStatus, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import {
  ActivationEvidenceDto,
  DEFAULT_EVIDENCE_PAGE,
  MAX_EVIDENCE_PAGE,
  ProofActivationAckService,
} from "./proof-activation-ack.service";

@ApiTags("proofs")
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@Controller("proofs/:id/activation-acknowledgements")
export class ProofActivationAckController {
  constructor(private readonly evidence: ProofActivationAckService) {}

  @ApiOperation({
    summary: "Get activation acknowledgement evidence for an owned proof",
    description:
      "Returns the off-chain projection of required and completed activation acknowledgements, " +
      "with explicit freshness. The projection is evidence only: it cannot mark a proof valid.",
  })
  @ApiParam({ name: "id", description: "Proof ID." })
  @ApiQuery({
    name: "limit",
    required: false,
    description: `Items to return. Default ${DEFAULT_EVIDENCE_PAGE}, maximum ${MAX_EVIDENCE_PAGE}.`,
  })
  @ApiResponse({ status: HttpStatus.OK, description: "Acknowledgement evidence." })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found or not accessible to this user.",
    type: ApiErrorDto,
  })
  @AuthenticatedRoute({ ownership: "user" })
  @UseGuards(AuthGuard)
  @Get()
  getEvidence(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Query("limit") limit?: string,
  ): Promise<ActivationEvidenceDto> {
    return this.evidence.getEvidence(
      user,
      id,
      limit === undefined ? DEFAULT_EVIDENCE_PAGE : Number(limit),
    );
  }
}
