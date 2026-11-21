import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { AuthGuard } from "../common/guards/auth.guard";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import {
  ConsentWithdrawalDto,
  ConsentWithdrawalReceiptDto,
  ConsentWithdrawalService,
  WithdrawalEligibilityDto,
} from "./consent-withdrawal.service";

const UNAUTHORIZED = {
  status: HttpStatus.UNAUTHORIZED,
  description: "Bearer token is missing, malformed, invalid, or expired.",
  type: ApiErrorDto,
};
const NOT_FOUND = {
  status: HttpStatus.NOT_FOUND,
  description: "Not found, or not accessible to this user.",
  type: ApiErrorDto,
};

/**
 * Subject-facing lifecycle for withdrawing consent to a proof disclosure.
 * Every route is scoped to the authenticated subject; another subject's
 * receipt or withdrawal is reported as not found. A withdrawal records the
 * subject's decision on the contract. It never deletes immutable records.
 */
@ApiTags("proofs")
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@UseGuards(AuthGuard)
@Controller()
export class ConsentWithdrawalController {
  constructor(private readonly withdrawals: ConsentWithdrawalService) {}

  @ApiOperation({ summary: "Check whether consent for a disclosure receipt can be withdrawn" })
  @ApiParam({ name: "receiptId", description: "Disclosure receipt ID." })
  @ApiResponse({ status: HttpStatus.OK, description: "Eligibility." })
  @ApiResponse(UNAUTHORIZED)
  @ApiResponse(NOT_FOUND)
  @AuthenticatedRoute({ ownership: "user" })
  @Get("proofs/disclosure-receipts/:receiptId/consent-withdrawal/eligibility")
  getEligibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param("receiptId") receiptId: string,
  ): Promise<WithdrawalEligibilityDto> {
    return this.withdrawals.getEligibility(user, receiptId);
  }

  @ApiOperation({
    summary: "Withdraw consent for a disclosure receipt",
    description:
      "Idempotent on the Idempotency-Key header. Replaying a request returns the same " +
      "withdrawal; reusing a key for a different request is rejected. The withdrawal is " +
      "submitted to the contract asynchronously; poll the status endpoint.",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "16-64 characters: letters, digits, '_' or '-'.",
  })
  @ApiParam({ name: "receiptId", description: "Disclosure receipt ID." })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: "Withdrawal accepted." })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Withdrawal is not available for this receipt.",
    type: ApiErrorDto,
  })
  @ApiResponse(UNAUTHORIZED)
  @ApiResponse(NOT_FOUND)
  @AuthenticatedRoute({ ownership: "user" })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post("proofs/disclosure-receipts/:receiptId/consent-withdrawal")
  requestWithdrawal(
    @CurrentUser() user: AuthenticatedUser,
    @Param("receiptId") receiptId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<ConsentWithdrawalDto> {
    return this.withdrawals.requestWithdrawal(user, receiptId, idempotencyKey);
  }

  @ApiOperation({ summary: "Get the status of a consent withdrawal" })
  @ApiParam({ name: "id", description: "Consent withdrawal ID." })
  @ApiResponse({ status: HttpStatus.OK, description: "Withdrawal status." })
  @ApiResponse(UNAUTHORIZED)
  @ApiResponse(NOT_FOUND)
  @AuthenticatedRoute({ ownership: "user" })
  @Get("proofs/consent-withdrawals/:id")
  getWithdrawal(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ConsentWithdrawalDto> {
    return this.withdrawals.getWithdrawal(user, id);
  }

  @ApiOperation({
    summary: "Reconcile a consent withdrawal",
    description:
      "Retries a pending or failed contract submission. Attempts are bounded and spaced by a cooldown.",
  })
  @ApiParam({ name: "id", description: "Consent withdrawal ID." })
  @ApiResponse({ status: HttpStatus.OK, description: "Withdrawal status after reconciliation." })
  @ApiResponse(UNAUTHORIZED)
  @ApiResponse(NOT_FOUND)
  @AuthenticatedRoute({ ownership: "user" })
  @HttpCode(HttpStatus.OK)
  @Post("proofs/consent-withdrawals/:id/reconcile")
  reconcile(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ConsentWithdrawalDto> {
    return this.withdrawals.reconcileWithdrawal(user, id);
  }

  @ApiOperation({
    summary: "Get the receipt for a confirmed consent withdrawal",
    description:
      "Available once the withdrawal is confirmed on the contract. The receipt states that " +
      "immutable records are retained, not deleted.",
  })
  @ApiParam({ name: "id", description: "Consent withdrawal ID." })
  @ApiResponse({ status: HttpStatus.OK, description: "Withdrawal receipt." })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "The withdrawal is not confirmed yet.",
    type: ApiErrorDto,
  })
  @ApiResponse(UNAUTHORIZED)
  @ApiResponse(NOT_FOUND)
  @AuthenticatedRoute({ ownership: "user" })
  @Get("proofs/consent-withdrawals/:id/receipt")
  getReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ConsentWithdrawalReceiptDto> {
    return this.withdrawals.getReceipt(user, id);
  }
}
