import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import {
  AuthenticatedRoute,
  PublicRoute,
} from "../common/decorators/authorization-policy.decorator";
import { Idempotent } from "../common/decorators/idempotent.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { CreateEmployerPaymentProofDto } from "./dto/create-employer-payment-proof.dto";
import { CreateMinimumIncomeProofDto } from "./dto/create-minimum-income-proof.dto";
import { CreatePaymentReceiptProofDto } from "./dto/create-payment-receipt-proof.dto";
import { CreateRecurringIncomeProofDto } from "./dto/create-recurring-income-proof.dto";
import { ListProofsDto } from "./dto/list-proofs.dto";
import { ProofCreatedDto } from "./dto/proof-created.dto";
import {
  ProofDetailResponseDto,
  ProofListResponseDto,
} from "./dto/proof-history-response.dto";
import { RevokeProofResponseDto } from "./dto/revoke-proof-response.dto";
import { VerifyProofResponseDto } from "./dto/verify-proof-response.dto";
import { VerificationStatsDto } from "./dto/verification-stats.dto";
import { ProofsService } from "./proofs.service";
import type { Request } from "express";

@ApiTags("proofs")
@Controller("proofs")
export class ProofsController {
  constructor(private readonly proofsService: ProofsService) {}

  @ApiBearerAuth()
  @ApiOperation({
    summary: "List the authenticated user's proofs",
    description:
      "Returns cursor-paginated proof summaries. The response separates local lifecycle status, credential validity, expiration, and contract anchoring state without exposing protected payment data.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Proof history page.",
    type: ProofListResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The cursor or issued-at date range is invalid.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get()
  @AuthenticatedRoute({ ownership: "user" })
  listProofs(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListProofsDto,
  ) {
    return this.proofsService.listProofs(user.id, query);
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get an owned proof",
    description:
      "Returns proof details for the owner or an administrator. Unknown and non-owned proof IDs produce the same not-found response.",
  })
  @ApiParam({ name: "id", description: "Proof ID (uuid)." })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Proof details.",
    type: ProofDetailResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found or not accessible to this user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get(":id")
  @AuthenticatedRoute({ ownership: "user" })
  getProofDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.proofsService.getProofDetail(user, id);
  }

  @ApiOperation({
    summary: "Create a selectively disclosed payment-receipt proof",
    description:
      "Issues a receipt credential for one eligible payment owned by the authenticated user. Sender and exact amount are hidden unless independently opted in.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Payment-receipt proof created.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Payment does not exist or belongs to another user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      "Payment is excluded, ineligible, or request validation failed.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Idempotency key was used with a different request payload.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Previous idempotent request is still being processed.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Idempotent({ headerName: "idempotency-key", required: true })
  @Post("payment-receipt")
  @AuthenticatedRoute({ ownership: "user" })
  createPaymentReceiptProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePaymentReceiptProofDto,
  ) {
    return this.proofsService.createPaymentReceiptProof(user, body);
  }

  @ApiOperation({
    summary: "Create a minimum-income proof",
    description:
      "Generates a privacy-preserving credential asserting that the authenticated wallet " +
      "received at least `thresholdAmount` of a given asset during the specified period. " +
      "The exact income and individual transactions are never disclosed; only the boolean " +
      "outcome (threshold met) is embedded in the credential.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      "Proof created. Returns the signed credential and an optional anchoring result.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Request body failed validation.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "Business rule violation — e.g. period range invalid, payments ineligible, " +
      "asset mismatch, or threshold not met.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Idempotency key was used with a different request payload.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Previous idempotent request is still being processed.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  // Proof creation is expensive (Stellar reads, contract anchoring) — the
  // "strict" tier, not "default". SkipThrottle excludes the OTHER named
  // throttlers so this route is judged against exactly one budget, not all
  // three simultaneously (see rate-limit.module.ts's doc comment).
  @SkipThrottle({ default: true, verification: true })
  @Throttle({ strict: {} })
  @Idempotent({ headerName: "idempotency-key", required: true })
  @Post("minimum-income")
  @AuthenticatedRoute({ ownership: "user" })
  createMinimumIncomeProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateMinimumIncomeProofDto,
  ) {
    return this.proofsService.createMinimumIncomeProof(user, body);
  }

  @ApiOperation({
    summary: "Create a recurring-income proof",
    description:
      "Issues a privacy-preserving credential when every requested cadence interval contains at least one eligible income payment in the selected asset.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Recurring-income proof created.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "The cadence is unsatisfied or a selected payment violates the ownership, classification, eligibility, asset, or period rules.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Idempotency key was used with a different request payload.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Previous idempotent request is still being processed.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Idempotent({ headerName: "idempotency-key", required: true })
  @Post("recurring-income")
  @AuthenticatedRoute({ ownership: "user" })
  createRecurringIncomeProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRecurringIncomeProofDto,
  ) {
    return this.proofsService.createRecurringIncomeProof(user, body);
  }

  @ApiOperation({
    summary: "Create an employer-payment proof",
    description:
      "Issues a minimal credential stating that the authenticated wallet received at least one eligible income " +
      "payment from a verified employer during a bounded period. The employer is identified by an active issuer " +
      "linked to one of the caller's trusted sources, and the issuer must corroborate the payer address. " +
      "The credential never contains the amount, sender, memo, transaction or payment date.",
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Employer-payment proof created.",
    type: ProofCreatedDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "The period is invalid, longer than 366 days, or ends in the future.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Trusted source does not exist or belongs to another user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      "The source is untrusted, revoked or ambiguous (EMPLOYER_SOURCE_UNTRUSTED, EMPLOYER_SOURCE_AMBIGUOUS), " +
      "no eligible payment falls inside the period (EMPLOYER_PAYMENT_NOT_FOUND), or request validation failed.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Idempotency key was used with a different request payload.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.REQUEST_TIMEOUT,
    description: "Previous idempotent request is still being processed.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @SkipThrottle({ default: true, verification: true })
  @Throttle({ strict: {} })
  @Idempotent({ headerName: "idempotency-key", required: true })
  @Post("employer-payment")
  @AuthenticatedRoute({ ownership: "user" })
  createEmployerPaymentProof(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateEmployerPaymentProofDto,
  ) {
    return this.proofsService.createEmployerPaymentProof(user, body);
  }

  @ApiOperation({
    summary: "Revoke a proof",
    description:
      "Marks the proof as REVOKED and records a revocation timestamp. " +
      "If the proof was anchored on-chain, a revocation transaction is also submitted. " +
      "Only the owner of the proof may revoke it.",
  })
  @ApiBearerAuth()
  @ApiParam({
    name: "id",
    description: "Proof ID (uuid).",
    example: "018e1234-abcd-7000-8000-abcdef012345",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Proof revoked.",
    type: RevokeProofResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "Proof does not belong to the authenticated user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Patch(":id/revoke")
  @AuthenticatedRoute({ ownership: "user" })
  revokeProof(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.proofsService.revokeProof(user.id, id);
  }

  @ApiOperation({
    summary: "Verify a proof (public)",
    description:
      "Public endpoint. Reconstructs the credential from the stored proof, recomputes the " +
      "HMAC commitment, and returns the verification result. No authentication required — " +
      "third parties such as issuers can call this endpoint directly.",
  })
  @ApiParam({
    name: "id",
    description: "Proof ID (uuid).",
    example: "018e1234-abcd-7000-8000-abcdef012345",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Verification result and the signed credential.",
    type: VerifyProofResponseDto,
  })
  @SkipThrottle({ default: true, strict: true })
  @Throttle({ verification: {} })
  @Get(":id/verify")
  @PublicRoute()
  verifyProof(@Param("id") id: string, @Req() request: Request) {
    return this.proofsService.verifyProof(id, { ip: request.ip });
  }

  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get aggregate verification statistics for a proof",
    description:
      "Returns privacy-safe outcome counts. Only the proof owner may access these statistics; verifier identity is never returned.",
  })
  @ApiParam({ name: "id", description: "Proof ID (uuid)." })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Aggregate verification outcome counts.",
    type: VerificationStatsDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: "Bearer token is missing, malformed, invalid, or expired.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: "The proof belongs to another user.",
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Proof not found.",
    type: ApiErrorDto,
  })
  @UseGuards(AuthGuard)
  @Get(":id/verification-stats")
  @AuthenticatedRoute({ ownership: "user" })
  getVerificationStats(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.proofsService.getVerificationStats(user.id, id);
  }
}
