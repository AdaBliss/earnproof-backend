import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AnchoringOperation,
  AnchoringStatus,
  AttestationType,
  PaymentClassification,
  Proof,
  ProofClaim,
  Prisma,
  ProofStatus,
  ProofType,
  ResourceStatus,
  VerificationResult,
  VerificationOutcome,
} from "@prisma/client";
import { createHmac, randomUUID } from "crypto";
import { VerificationEventService } from "../audit/verification-event.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { canonicalize } from "../common/crypto/canonicalize";
import { CredentialVerificationKeyService } from "../common/crypto/credential-verification-key.service";
import { sha256 } from "../common/crypto/hash";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { ApiErrorCode } from "../common/dto/api-error.dto";
import { PrismaService } from "../database/prisma.service";
import { AttestationsService } from "../attestations/attestations.service";
import { WebhookDeliveryService } from "../webhooks/webhook-delivery.service";
import {
  ProofVerificationAbuseService,
  VerificationClientContext,
} from "../common/rate-limit/proof-verification-abuse.service";
import { ContractAnchoringService } from "./contract-anchoring.service";
import { CreateEmployerPaymentProofDto } from "./dto/create-employer-payment-proof.dto";
import { CreateEmploymentContinuityProofDto } from "./dto/create-employment-continuity-proof.dto";
import { CreateMinimumIncomeProofDto } from "./dto/create-minimum-income-proof.dto";
import { CreatePaymentReceiptProofDto } from "./dto/create-payment-receipt-proof.dto";
import {
  CreateRecurringIncomeProofDto,
  IntervalUnit,
} from "./dto/create-recurring-income-proof.dto";
import { ListProofsDto } from "./dto/list-proofs.dto";
import {
  EMPLOYER_PAYMENT_POLICY_VERSION,
  EmployerCorroboration,
  EmployerPaymentPeriodViolation,
  EmployerSourceResolution,
  MAX_EMPLOYER_PAYMENT_CANDIDATES,
  MAX_EMPLOYER_PAYMENT_PERIOD_DAYS,
  resolveEmployerSource,
  selectEmployerPayment,
  validateEmployerPaymentPeriod,
} from "./employer-payment.policy";
import {
  CONTINUITY_PERIOD_UNIT,
  ContinuityWindowViolation,
  EMPLOYMENT_CONTINUITY_POLICY_VERSION,
  MAX_CONTINUITY_PAYMENTS,
  MAX_CONTINUITY_PERIODS,
  MAX_MISSING_CONTINUITY_PERIODS,
  MIN_CONTINUITY_PERIODS,
  buildContinuityWindow,
  evaluateContinuity,
} from "./employment-continuity.policy";

const SCHEMA_VERSION = "earnproof.minimum-income.v1";
const PAYMENT_RECEIPT_SCHEMA_VERSION = "earnproof.payment-receipt.v1";
const RECURRING_INCOME_SCHEMA_VERSION = "earnproof.recurring-income.v1";
const EMPLOYER_PAYMENT_SCHEMA_VERSION = "earnproof.employer-payment.v1";
const EMPLOYMENT_CONTINUITY_SCHEMA_VERSION =
  "earnproof.employment-continuity.v1";
const DEFAULT_EXPIRY_DAYS = 30;

const EMPLOYER_PERIOD_MESSAGES: Record<EmployerPaymentPeriodViolation, string> =
  {
    invalid_date: "periodStart and periodEnd must be valid dates",
    empty_or_inverted: "periodStart must be before periodEnd",
    too_long: `The period must not exceed ${MAX_EMPLOYER_PAYMENT_PERIOD_DAYS} days`,
    ends_in_future: "periodEnd must not be in the future",
  };

const CONTINUITY_WINDOW_MESSAGES: Record<ContinuityWindowViolation, string> = {
  invalid_date: "periodStart must be a valid date",
  not_period_aligned:
    "periodStart must be the first instant of a UTC calendar month",
  invalid_period_count: `observedPeriods must be an integer between ${MIN_CONTINUITY_PERIODS} and ${MAX_CONTINUITY_PERIODS}`,
  window_not_complete: "The observed window must have ended",
};

type MinimumIncomeCredential = {
  id: string;
  type: "EarnProofMinimumIncomeCredential";
  schemaVersion: string;
  issuer: "earnproof-backend";
  subject: {
    walletHash: string;
  };
  claim: {
    operator: "gte";
    thresholdAmount: string;
    assetCode: string;
    assetIssuer: string | null;
    periodStart: string;
    periodEnd: string;
    qualifyingPaymentCount: number;
  };
  privacy: {
    exactIncomeHidden: true;
    sourceTransactionsHidden: true;
  };
  issuedAt: string;
  expiresAt: string;
};

type PaymentReceiptCredential = {
  id: string;
  type: "EarnProofPaymentReceiptCredential";
  schemaVersion: "earnproof.payment-receipt.v1";
  issuer: "earnproof-backend";
  subject: { walletHash: string };
  claim: {
    assetCode: string;
    assetIssuer: string | null;
    occurredAt: string;
    paymentReferenceHash: string;
    sourceAddress?: string;
    amount?: string;
  };
  privacy: { senderHidden: boolean; amountHidden: boolean };
  issuedAt: string;
  expiresAt: string;
};

type RecurringIncomeCredential = {
  id: string;
  type: "EarnProofRecurringIncomeCredential";
  schemaVersion: "earnproof.recurring-income.v1";
  issuer: "earnproof-backend";
  subject: { walletHash: string };
  claim: {
    cadence: string;
    intervalUnit: IntervalUnit;
    intervalCount: number;
    assetCode: string;
    assetIssuer: string | null;
    periodStart: string;
    periodEnd: string;
    qualifyingPaymentCount: number;
  };
  privacy: {
    exactIncomeHidden: true;
    sourceTransactionsHidden: true;
  };
  issuedAt: string;
  expiresAt: string;
};

type EmployerPaymentCredential = {
  id: string;
  type: "EarnProofEmployerPaymentCredential";
  schemaVersion: "earnproof.employer-payment.v1";
  issuer: "earnproof-backend";
  subject: { walletHash: string };
  claim: {
    employerIssuerId: string;
    corroboration: EmployerCorroboration;
    assetCode: string;
    assetIssuer: string | null;
    periodStart: string;
    periodEnd: string;
    periodBoundary: "start-inclusive-end-exclusive";
    paymentObserved: true;
    policyVersion: string;
  };
  privacy: {
    amountHidden: true;
    senderHidden: true;
    memoHidden: true;
    sourceTransactionsHidden: true;
  };
  issuedAt: string;
  expiresAt: string;
};

type EmploymentContinuityCredential = {
  id: string;
  type: "EarnProofEmploymentContinuityCredential";
  schemaVersion: "earnproof.employment-continuity.v1";
  issuer: "earnproof-backend";
  subject: { walletHash: string };
  claim: {
    employerIssuerId: string;
    assetCode: string;
    assetIssuer: string | null;
    periodStart: string;
    periodEnd: string;
    periodUnit: string;
    observedPeriods: number;
    toleratedMissingPeriods: number;
    continuous: true;
    policyVersion: string;
  };
  privacy: {
    amountHidden: true;
    senderHidden: true;
    memoHidden: true;
    sourceTransactionsHidden: true;
    paymentDatesHidden: true;
  };
  issuedAt: string;
  expiresAt: string;
};

type EarnProofCredential =
  | MinimumIncomeCredential
  | PaymentReceiptCredential
  | RecurringIncomeCredential
  | EmployerPaymentCredential
  | EmploymentContinuityCredential;

type EmployerSourceLockRow = {
  sourceStatus: ResourceStatus;
  sourceAddress: string;
  issuerId: string | null;
  issuerStatus: ResourceStatus | null;
  organizationStatus: ResourceStatus | null;
};

type AttestationLockRow = {
  id?: string;
  status: ResourceStatus;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

@Injectable()
export class ProofsService {
  private readonly signingSecret: string;
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;
  private readonly stellarNetwork: string;
  private readonly anchoringEnabled: boolean;
  private readonly anchoringRequired: boolean;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly verificationEventService: VerificationEventService,
    private readonly attestationsService: AttestationsService,
    @Optional()
    private readonly contractAnchoringService?: ContractAnchoringService,
    @Optional()
    private readonly webhookDeliveryService?: WebhookDeliveryService,
    @Optional()
    private readonly credentialVerificationKeyService?: CredentialVerificationKeyService,
    private readonly verificationAbuseService?: ProofVerificationAbuseService,
  ) {
    this.signingSecret = configService.getOrThrow<string>(
      "credentialSigningSecret",
    );
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(
      configService,
    );
    this.stellarNetwork = configService.getOrThrow<string>("stellar.network");
    this.anchoringEnabled =
      configService.get<boolean>("contractAnchoring.enabled") ?? false;
    this.anchoringRequired =
      configService.get<boolean>("contractAnchoring.required") ?? false;
  }

  async createPaymentReceiptProof(
    user: AuthenticatedUser,
    input: CreatePaymentReceiptProofDto,
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: input.paymentId, userId: user.id },
      select: {
        operationId: true,
        sourceAddress: true,
        assetCode: true,
        assetIssuer: true,
        amountEncrypted: true,
        classification: true,
        isEligible: true,
        occurredAt: true,
      },
    });

    if (!payment) {
      throw new NotFoundException({
        code: ApiErrorCode.PAYMENT_NOT_FOUND,
        message: "Payment not found",
      });
    }
    if (!payment.isEligible) {
      throw new UnprocessableEntityException({
        code: ApiErrorCode.PAYMENT_NOT_ELIGIBLE,
        message: "Payment is not eligible for proof issuance",
      });
    }
    if (payment.classification === PaymentClassification.EXCLUDED) {
      throw new UnprocessableEntityException({
        code: ApiErrorCode.PAYMENT_EXCLUDED,
        message: "Payment is excluded from proof issuance",
      });
    }

    const senderHidden = input.discloseSender !== true;
    const amountHidden = input.discloseAmount !== true;
    const amount = amountHidden
      ? undefined
      : this.revealPaymentAmount(payment.amountEncrypted);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() +
        (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
    );
    const proofId = randomUUID();
    const paymentReferenceHash = `sha256:${sha256(payment.operationId)}`;
    const credential = this.buildPaymentReceiptCredential({
      id: proofId,
      walletHash: user.walletHash,
      assetCode: payment.assetCode,
      assetIssuer: payment.assetIssuer,
      occurredAt: payment.occurredAt,
      paymentReferenceHash,
      senderHidden,
      amountHidden,
      sourceAddress: senderHidden ? undefined : payment.sourceAddress,
      amount,
      issuedAt: now,
      expiresAt,
    });
    const credentialHash = `sha256:${sha256(canonicalize(credential))}`;
    const commitment = `sha256:${sha256(credentialHash)}`;

    const proof = await this.prisma.$transaction(async (tx) => {
      const created = await tx.proof.create({
        data: {
          id: proofId,
          userId: user.id,
          proofType: ProofType.PAYMENT_RECEIPT,
          schemaVersion: PAYMENT_RECEIPT_SCHEMA_VERSION,
          status: ProofStatus.ACTIVE,
          network: this.stellarNetwork,
          assetCode: payment.assetCode,
          assetIssuer: payment.assetIssuer,
          periodStart: payment.occurredAt,
          periodEnd: payment.occurredAt,
          expiresAt,
          createdAt: now,
          credentialHash,
          commitment,
          claim: {
            create: {
              operator: "receipt",
              thresholdEncrypted: amountHidden
                ? null
                : payment.amountEncrypted,
              result: true,
              disclosurePolicy: {
                senderHidden,
                amountHidden,
                paymentReferenceHash,
                occurredAt: payment.occurredAt.toISOString(),
                ...(senderHidden
                  ? undefined
                  : { sourceAddress: payment.sourceAddress }),
              },
            },
          },
        },
        include: { claim: true },
      });

      if (this.anchoringEnabled) {
        await tx.anchoringIntent.create({
          data: {
            proofId: created.id,
            operation: AnchoringOperation.REGISTER,
            status: AnchoringStatus.PENDING,
          },
        });
      }

      return created;
    });

    const anchoringResult = this.anchoringEnabled
      ? { anchored: false as const, reason: "pending" as const }
      : { anchored: false as const, reason: "disabled" as const };

    this.emitProofCreated(user.id, proof);
    return {
      proofId: proof.id,
      status: proof.status,
      verificationUrl: `/api/v1/proofs/${proof.id}/verify`,
      credential: this.signCredential(credential),
      anchoring: anchoringResult,
    };
  }

  async listProofs(userId: string, input: ListProofsDto) {
    const issuedFrom = input.issuedFrom
      ? new Date(input.issuedFrom)
      : undefined;
    const issuedTo = input.issuedTo ? new Date(input.issuedTo) : undefined;
    if (issuedFrom && issuedTo && issuedFrom > issuedTo) {
      throw new BadRequestException("issuedFrom must be before issuedTo");
    }

    if (input.cursor) {
      const cursor = await this.prisma.proof.findFirst({
        where: { id: input.cursor, userId },
        select: { id: true },
      });
      if (!cursor) {
        throw new BadRequestException("Invalid proof cursor");
      }
    }

    const limit = input.limit ?? 20;
    const where: Prisma.ProofWhereInput = {
      userId,
      proofType: input.type,
      status: input.status,
      assetCode: input.assetCode,
      createdAt:
        issuedFrom || issuedTo ? { gte: issuedFrom, lte: issuedTo } : undefined,
    };
    const proofs = await this.prisma.proof.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : undefined),
    });
    const hasMore = proofs.length > limit;
    const page = hasMore ? proofs.slice(0, limit) : proofs;

    return {
      data: page.map((proof) => this.toHistoryItem(proof)),
      pageInfo: {
        hasMore,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      },
    };
  }

  async getProofDetail(user: AuthenticatedUser, proofId: string) {
    const proof = await this.prisma.proof.findFirst({
      where:
        user.role === "ADMIN"
          ? { id: proofId }
          : { id: proofId, userId: user.id },
      include: { claim: true },
    });

    if (!proof) {
      throw new NotFoundException("Proof not found");
    }

    return {
      ...this.toHistoryItem(proof),
      anchoring: await this.proofAnchoringDetail(proof),
      claim: this.claimSummary(proof.claim),
    };
  }

  async createMinimumIncomeProof(
    user: AuthenticatedUser,
    input: CreateMinimumIncomeProofDto,
  ) {
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);

    if (periodStart > periodEnd) {
      throw new BadRequestException("periodStart must be before periodEnd");
    }

    const selectedPaymentIds = [...new Set(input.selectedPaymentIds)];
    const payments = await this.prisma.payment.findMany({
      where: {
        id: {
          in: selectedPaymentIds,
        },
        userId: user.id,
      },
      select: {
        id: true,
        assetCode: true,
        assetIssuer: true,
        amountEncrypted: true,
        classification: true,
        isEligible: true,
        occurredAt: true,
      },
    });

    if (payments.length !== selectedPaymentIds.length) {
      throw new BadRequestException(
        "One or more selected payments are invalid",
      );
    }

    for (const payment of payments) {
      if (
        payment.classification !== PaymentClassification.INCOME ||
        !payment.isEligible
      ) {
        throw new BadRequestException(
          "Selected payments must be eligible income payments",
        );
      }

      if (
        payment.assetCode !== input.assetCode ||
        (payment.assetIssuer ?? null) !== (input.assetIssuer ?? null)
      ) {
        throw new BadRequestException(
          "Selected payments must use the requested asset",
        );
      }

      if (payment.occurredAt < periodStart || payment.occurredAt > periodEnd) {
        throw new BadRequestException(
          "Selected payments must fall inside the requested period",
        );
      }
    }

    const total = payments.reduce(
      (sum, payment) =>
        sum + this.revealProtectedAmount(payment.amountEncrypted),
      0n,
    );
    const threshold = this.parseAmount(input.thresholdAmount);

    if (total < threshold) {
      throw new BadRequestException(
        "Selected payments do not satisfy the minimum income threshold",
      );
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() +
        (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
    );

    const proofId = randomUUID();
    const draftCredential = this.buildCredential({
      id: proofId,
      walletHash: user.walletHash,
      thresholdAmount: input.thresholdAmount,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer ?? null,
      periodStart,
      periodEnd,
      qualifyingPaymentCount: payments.length,
      issuedAt: now,
      expiresAt,
    });
    const credentialHash = `sha256:${sha256(canonicalize(draftCredential))}`;
    const commitment = `sha256:${sha256(credentialHash)}`;

    // Write Proof + ProofClaim + AnchoringIntent in a single transaction.
    // The intent is enqueued here (PENDING) even before any external call so
    // that a crash after this point is recoverable by the worker.
    const proof = await this.prisma.$transaction(async (tx) => {
      const created = await tx.proof.create({
        data: {
          id: proofId,
          userId: user.id,
          proofType: ProofType.MINIMUM_INCOME,
          schemaVersion: SCHEMA_VERSION,
          status: ProofStatus.ACTIVE,
          network: this.stellarNetwork,
          assetCode: input.assetCode,
          assetIssuer: input.assetIssuer ?? null,
          periodStart,
          periodEnd,
          expiresAt,
          createdAt: now,
          credentialHash,
          commitment,
          claim: {
            create: {
              operator: "gte",
              thresholdEncrypted: this.protectAmount(input.thresholdAmount),
              result: true,
              disclosurePolicy: {
                exactIncomeHidden: true,
                sourceTransactionsHidden: true,
                qualifyingPaymentCount: payments.length,
              },
            },
          },
        },
        include: {
          claim: true,
        },
      });

      // Only enqueue an anchoring intent when anchoring is configured.
      if (this.anchoringEnabled) {
        await tx.anchoringIntent.create({
          data: {
            proofId: created.id,
            operation: AnchoringOperation.REGISTER,
            status: AnchoringStatus.PENDING,
          },
        });
      }

      return created;
    });

    const credential = this.buildCredential({
      id: proof.id,
      walletHash: user.walletHash,
      thresholdAmount: input.thresholdAmount,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer ?? null,
      periodStart,
      periodEnd,
      qualifyingPaymentCount: payments.length,
      issuedAt: proof.createdAt,
      expiresAt: proof.expiresAt,
    });

    // Anchoring is now async (handled by AnchoringWorkerService).
    // Return a "pending" anchoring status so callers know to poll verify later.
    const anchoringResult = this.anchoringEnabled
      ? { anchored: false as const, reason: "pending" as const }
      : { anchored: false as const, reason: "disabled" as const };

    this.emitProofCreated(user.id, proof);
    return {
      proofId: proof.id,
      status: proof.status,
      verificationUrl: `/api/v1/proofs/${proof.id}/verify`,
      credential: this.signCredential(credential),
      anchoring: anchoringResult,
    };
  }

  async createRecurringIncomeProof(
    user: AuthenticatedUser,
    input: CreateRecurringIncomeProofDto,
  ) {
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    if (periodStart >= periodEnd) {
      throw new BadRequestException("periodStart must be before periodEnd");
    }

    const intervals = this.buildRecurringIntervals(
      periodStart,
      periodEnd,
      input.intervalUnit,
      input.intervalCount,
    );
    const selectedPaymentIds = [...new Set(input.selectedPaymentIds)];
    const payments = await this.prisma.payment.findMany({
      where: { id: { in: selectedPaymentIds }, userId: user.id },
      select: {
        id: true,
        assetCode: true,
        assetIssuer: true,
        classification: true,
        isEligible: true,
        occurredAt: true,
      },
    });

    if (payments.length !== selectedPaymentIds.length) {
      throw new BadRequestException(
        "One or more selected payments are invalid",
      );
    }

    for (const payment of payments) {
      if (
        payment.classification !== PaymentClassification.INCOME ||
        !payment.isEligible
      ) {
        throw new BadRequestException(
          "Selected payments must be eligible income payments",
        );
      }
      if (
        payment.assetCode !== input.assetCode ||
        (payment.assetIssuer ?? null) !== (input.assetIssuer ?? null)
      ) {
        throw new BadRequestException(
          "Selected payments must use the requested asset",
        );
      }
      if (payment.occurredAt < periodStart || payment.occurredAt > periodEnd) {
        throw new BadRequestException(
          "Selected payments must fall inside the requested period",
        );
      }
    }

    const missingIntervals = intervals.filter(
      ([start, end]) =>
        !payments.some(
          (payment) =>
            payment.occurredAt >= start && payment.occurredAt <= end,
        ),
    );
    if (missingIntervals.length > 0) {
      throw new BadRequestException(
        `Recurring income proof unsatisfied: ${missingIntervals.length} of ${intervals.length} interval(s) contain no qualifying payment`,
      );
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() +
        (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
    );
    const proofId = randomUUID();
    const cadence = `${input.intervalUnit}:${input.intervalCount}`;
    const draftCredential = this.buildRecurringIncomeCredential({
      id: proofId,
      walletHash: user.walletHash,
      cadence,
      intervalUnit: input.intervalUnit,
      intervalCount: input.intervalCount,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer ?? null,
      periodStart,
      periodEnd,
      qualifyingPaymentCount: payments.length,
      issuedAt: now,
      expiresAt,
    });
    const credentialHash = `sha256:${sha256(canonicalize(draftCredential))}`;
    const commitment = `sha256:${sha256(credentialHash)}`;

    const proof = await this.prisma.$transaction(async (tx) => {
      const created = await tx.proof.create({
        data: {
          id: proofId,
          userId: user.id,
          proofType: ProofType.RECURRING_INCOME,
          schemaVersion: RECURRING_INCOME_SCHEMA_VERSION,
          status: ProofStatus.ACTIVE,
          network: this.stellarNetwork,
          assetCode: input.assetCode,
          assetIssuer: input.assetIssuer ?? null,
          periodStart,
          periodEnd,
          expiresAt,
          createdAt: now,
          credentialHash,
          commitment,
          claim: {
            create: {
              operator: "recurring",
              frequency: cadence,
              result: true,
              disclosurePolicy: {
                exactIncomeHidden: true,
                sourceTransactionsHidden: true,
                qualifyingPaymentCount: payments.length,
                intervalUnit: input.intervalUnit,
                intervalCount: input.intervalCount,
              },
            },
          },
        },
        include: { claim: true },
      });

      if (this.anchoringEnabled) {
        await tx.anchoringIntent.create({
          data: {
            proofId: created.id,
            operation: AnchoringOperation.REGISTER,
            status: AnchoringStatus.PENDING,
          },
        });
      }
      return created;
    });

    const credential = this.buildRecurringIncomeCredential({
      id: proof.id,
      walletHash: user.walletHash,
      cadence,
      intervalUnit: input.intervalUnit,
      intervalCount: input.intervalCount,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer ?? null,
      periodStart,
      periodEnd,
      qualifyingPaymentCount: payments.length,
      issuedAt: proof.createdAt,
      expiresAt: proof.expiresAt,
    });

    return {
      proofId: proof.id,
      status: proof.status,
      verificationUrl: `/api/v1/proofs/${proof.id}/verify`,
      credential: this.signCredential(credential),
      anchoring: this.anchoringEnabled
        ? { anchored: false as const, reason: "pending" as const }
        : { anchored: false as const, reason: "disabled" as const },
    };
  }

  /**
   * Issues an employer-payment proof (earnproof-backend#165).
   *
   * The employer is identified by an issuer, reached through one of the
   * caller's trusted sources. A trusted source is user-declared, so it only
   * counts when the issuer corroborates the payer address: either the payment
   * came from the issuer's own registered account, or the issuer holds an
   * active PAYMENT attestation for that exact payment. Source, issuer,
   * organization, attestation and payment are re-read under row locks inside
   * the issuing transaction, so a concurrent revocation either commits first
   * (and issuance is refused) or waits until the proof is committed.
   */
  async createEmployerPaymentProof(
    user: AuthenticatedUser,
    input: CreateEmployerPaymentProofDto,
  ) {
    const periodStart = new Date(input.periodStart);
    const periodEnd = new Date(input.periodEnd);
    const now = new Date();
    const periodViolation = validateEmployerPaymentPeriod(
      periodStart,
      periodEnd,
      now,
    );
    if (periodViolation) {
      throw new BadRequestException({
        code: ApiErrorCode.INVALID_INPUT,
        message: EMPLOYER_PERIOD_MESSAGES[periodViolation],
      });
    }

    const { sourceId, resolution } = await this.resolveTrustedEmployer(
      user.id,
      input.trustedSourceId,
    );

    const assetIssuer = input.assetIssuer ?? null;
    const candidates = await this.prisma.payment.findMany({
      where: {
        userId: user.id,
        sourceAddress: resolution.sourceAddress,
        assetCode: input.assetCode,
        assetIssuer,
        classification: PaymentClassification.INCOME,
        isEligible: true,
        occurredAt: { gte: periodStart, lt: periodEnd },
      },
      select: { id: true, operationId: true, occurredAt: true },
      orderBy: [{ occurredAt: "desc" }, { operationId: "asc" }],
      take: MAX_EMPLOYER_PAYMENT_CANDIDATES,
    });
    if (candidates.length === 0) {
      throw new UnprocessableEntityException({
        code: ApiErrorCode.EMPLOYER_PAYMENT_NOT_FOUND,
        message:
          "No eligible income payment from this employer source falls inside the requested period",
      });
    }

    const attestationByReference = resolution.isIssuerAccount
      ? new Map<string, string>()
      : await this.findPaymentAttestations(
          resolution.issuerId,
          user.walletHash,
          candidates,
          now,
        );

    const selection = selectEmployerPayment(
      candidates,
      resolution.isIssuerAccount,
      new Set(attestationByReference.keys()),
      (candidate) => this.paymentReferenceHash(candidate.operationId),
    );
    if (!selection) {
      throw new UnprocessableEntityException({
        code: ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
        message:
          "No payment from this source is corroborated by the linked issuer",
      });
    }
    const attestationId =
      selection.corroboration === "issuer_attestation"
        ? attestationByReference.get(
            this.paymentReferenceHash(selection.payment.operationId),
          )
        : undefined;

    const expiresAt = new Date(
      now.getTime() +
        (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
    );
    const proofId = randomUUID();
    const credential = this.buildEmployerPaymentCredential({
      id: proofId,
      walletHash: user.walletHash,
      employerIssuerId: resolution.issuerId,
      corroboration: selection.corroboration,
      assetCode: input.assetCode,
      assetIssuer,
      periodStart,
      periodEnd,
      policyVersion: EMPLOYER_PAYMENT_POLICY_VERSION,
      issuedAt: now,
      expiresAt,
    });
    const credentialHash = `sha256:${sha256(canonicalize(credential))}`;
    const commitment = `sha256:${sha256(credentialHash)}`;

    const proof = await this.prisma.$transaction(async (tx) => {
      await this.assertEmployerStillTrusted(tx, sourceId, user.id, resolution);

      if (attestationId) {
        const [attestation] = await tx.$queryRaw<AttestationLockRow[]>`
          SELECT "status", "revokedAt", "expiresAt"
          FROM "Attestation"
          WHERE "id" = ${attestationId}
          FOR SHARE
        `;
        if (
          !attestation ||
          attestation.status !== ResourceStatus.ACTIVE ||
          attestation.revokedAt !== null ||
          (attestation.expiresAt !== null && attestation.expiresAt <= now)
        ) {
          throw this.employerSourceError("source_inactive");
        }
      }

      const [payment] = await tx.$queryRaw<
        Array<{ classification: PaymentClassification; isEligible: boolean }>
      >`
        SELECT "classification", "isEligible"
        FROM "Payment"
        WHERE "id" = ${selection.payment.id} AND "userId" = ${user.id}
        FOR SHARE
      `;
      if (
        !payment ||
        payment.classification !== PaymentClassification.INCOME ||
        !payment.isEligible
      ) {
        throw new UnprocessableEntityException({
          code: ApiErrorCode.EMPLOYER_PAYMENT_NOT_FOUND,
          message:
            "No eligible income payment from this employer source falls inside the requested period",
        });
      }

      const created = await tx.proof.create({
        data: {
          id: proofId,
          userId: user.id,
          proofType: ProofType.EMPLOYER_PAYMENT,
          schemaVersion: EMPLOYER_PAYMENT_SCHEMA_VERSION,
          status: ProofStatus.ACTIVE,
          network: this.stellarNetwork,
          assetCode: input.assetCode,
          assetIssuer,
          periodStart,
          periodEnd,
          expiresAt,
          createdAt: now,
          credentialHash,
          commitment,
          claim: {
            create: {
              operator: "employer_payment",
              result: true,
              disclosurePolicy: {
                policyVersion: EMPLOYER_PAYMENT_POLICY_VERSION,
                employerIssuerId: resolution.issuerId,
                corroboration: selection.corroboration,
                // Keyed digest: links the proof to its payment for audit
                // without storing the operation id or making it guessable.
                paymentReferenceDigest: this.keyedDigest(
                  selection.payment.operationId,
                ),
                amountHidden: true,
                senderHidden: true,
                memoHidden: true,
                sourceTransactionsHidden: true,
              },
            },
          },
        },
        include: { claim: true },
      });

      if (this.anchoringEnabled) {
        await tx.anchoringIntent.create({
          data: {
            proofId: created.id,
            operation: AnchoringOperation.REGISTER,
            status: AnchoringStatus.PENDING,
          },
        });
      }

      return created;
    });

    this.emitProofCreated(user.id, proof);
    return {
      proofId: proof.id,
      status: proof.status,
      verificationUrl: `/api/v1/proofs/${proof.id}/verify`,
      credential: this.signCredential(credential),
      anchoring: this.anchoringEnabled
        ? { anchored: false as const, reason: "pending" as const }
        : { anchored: false as const, reason: "disabled" as const },
    };
  }

  /**
   * Issues an employment-continuity proof (earnproof-backend#166).
   *
   * Payments are bucketed into UTC calendar months over a completed window.
   * Only payments from one trusted employer source count, under the same
   * issuer corroboration rule as employer-payment proofs. The credential
   * commits only to the continuity result and the policy it was evaluated
   * under; it carries no payment dates, amounts or identifiers.
   */
  async createEmploymentContinuityProof(
    user: AuthenticatedUser,
    input: CreateEmploymentContinuityProofDto,
  ) {
    const now = new Date();
    const built = buildContinuityWindow(
      new Date(input.periodStart),
      input.observedPeriods,
      now,
    );
    if ("violation" in built) {
      throw new BadRequestException({
        code: ApiErrorCode.INVALID_INPUT,
        message: CONTINUITY_WINDOW_MESSAGES[built.violation],
      });
    }
    const { window } = built;

    const { sourceId, resolution } = await this.resolveTrustedEmployer(
      user.id,
      input.trustedSourceId,
    );

    const assetIssuer = input.assetIssuer ?? null;
    const payments = await this.prisma.payment.findMany({
      where: {
        userId: user.id,
        sourceAddress: resolution.sourceAddress,
        assetCode: input.assetCode,
        assetIssuer,
        classification: PaymentClassification.INCOME,
        isEligible: true,
        occurredAt: { gte: window.start, lt: window.end },
      },
      select: { id: true, operationId: true, occurredAt: true },
      orderBy: [{ occurredAt: "asc" }, { operationId: "asc" }],
      take: MAX_CONTINUITY_PAYMENTS + 1,
    });
    if (payments.length > MAX_CONTINUITY_PAYMENTS) {
      throw new UnprocessableEntityException({
        code: ApiErrorCode.CONTINUITY_LIMIT_EXCEEDED,
        message: `The window contains more than ${MAX_CONTINUITY_PAYMENTS} payments; request a shorter window`,
      });
    }

    const attestationByReference = resolution.isIssuerAccount
      ? new Map<string, string>()
      : await this.findPaymentAttestations(
          resolution.issuerId,
          user.walletHash,
          payments,
          now,
        );
    const attestationFor = (payment: { operationId: string }) =>
      attestationByReference.get(this.paymentReferenceHash(payment.operationId));

    const evaluation = evaluateContinuity(
      payments.filter(
        (payment) =>
          resolution.isIssuerAccount || attestationFor(payment) !== undefined,
      ),
      window,
    );
    if (!evaluation.continuous) {
      throw this.continuityNotSatisfied();
    }

    const expiresAt = new Date(
      now.getTime() +
        (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
    );
    const proofId = randomUUID();
    const credential = this.buildEmploymentContinuityCredential({
      id: proofId,
      walletHash: user.walletHash,
      employerIssuerId: resolution.issuerId,
      assetCode: input.assetCode,
      assetIssuer,
      periodStart: window.start,
      periodEnd: window.end,
      periodUnit: CONTINUITY_PERIOD_UNIT,
      observedPeriods: window.periods,
      toleratedMissingPeriods: MAX_MISSING_CONTINUITY_PERIODS,
      policyVersion: EMPLOYMENT_CONTINUITY_POLICY_VERSION,
      issuedAt: now,
      expiresAt,
    });
    const credentialHash = `sha256:${sha256(canonicalize(credential))}`;
    const commitment = `sha256:${sha256(credentialHash)}`;

    const proof = await this.prisma.$transaction(async (tx) => {
      await this.assertEmployerStillTrusted(tx, sourceId, user.id, resolution);

      // Re-read every counted payment (and its attestation) under a shared
      // lock, drop any that stopped qualifying, and re-evaluate: the proof is
      // only committed if the rule still holds on the locked rows.
      const included = evaluation.includedPayments;
      const lockedPayments = await tx.$queryRaw<
        Array<{
          id: string;
          classification: PaymentClassification;
          isEligible: boolean;
        }>
      >`
        SELECT "id", "classification", "isEligible"
        FROM "Payment"
        WHERE "id" IN (${Prisma.join(included.map((payment) => payment.id))})
          AND "userId" = ${user.id}
        FOR SHARE
      `;
      const qualifyingPaymentIds = new Set(
        lockedPayments
          .filter(
            (row) =>
              row.classification === PaymentClassification.INCOME &&
              row.isEligible,
          )
          .map((row) => row.id),
      );

      let validAttestationIds: Set<string> | null = null;
      if (!resolution.isIssuerAccount) {
        const lockedAttestations = await tx.$queryRaw<AttestationLockRow[]>`
          SELECT "id", "status", "revokedAt", "expiresAt"
          FROM "Attestation"
          WHERE "id" IN (${Prisma.join(
            included.map((payment) => attestationFor(payment) as string),
          )})
          FOR SHARE
        `;
        validAttestationIds = new Set(
          lockedAttestations
            .filter(
              (row) =>
                row.status === ResourceStatus.ACTIVE &&
                row.revokedAt === null &&
                (row.expiresAt === null || row.expiresAt > now),
            )
            .map((row) => row.id as string),
        );
      }

      const stillQualifying = included.filter(
        (payment) =>
          qualifyingPaymentIds.has(payment.id) &&
          (validAttestationIds === null ||
            validAttestationIds.has(attestationFor(payment) as string)),
      );
      const locked = evaluateContinuity(stillQualifying, window);
      if (!locked.continuous) {
        throw this.continuityNotSatisfied();
      }

      const created = await tx.proof.create({
        data: {
          id: proofId,
          userId: user.id,
          proofType: ProofType.EMPLOYMENT_CONTINUITY,
          schemaVersion: EMPLOYMENT_CONTINUITY_SCHEMA_VERSION,
          status: ProofStatus.ACTIVE,
          network: this.stellarNetwork,
          assetCode: input.assetCode,
          assetIssuer,
          periodStart: window.start,
          periodEnd: window.end,
          expiresAt,
          createdAt: now,
          credentialHash,
          commitment,
          claim: {
            create: {
              operator: "employment_continuity",
              frequency: CONTINUITY_PERIOD_UNIT,
              result: true,
              disclosurePolicy: {
                policyVersion: EMPLOYMENT_CONTINUITY_POLICY_VERSION,
                employerIssuerId: resolution.issuerId,
                periodUnit: CONTINUITY_PERIOD_UNIT,
                observedPeriods: window.periods,
                toleratedMissingPeriods: MAX_MISSING_CONTINUITY_PERIODS,
                // Keyed digest of the counted operation ids, for audit only.
                includedPaymentsDigest: this.keyedDigest(
                  locked.includedPayments
                    .map((payment) => payment.operationId)
                    .join("\n"),
                ),
                amountHidden: true,
                senderHidden: true,
                memoHidden: true,
                sourceTransactionsHidden: true,
                paymentDatesHidden: true,
              },
            },
          },
        },
        include: { claim: true },
      });

      if (this.anchoringEnabled) {
        await tx.anchoringIntent.create({
          data: {
            proofId: created.id,
            operation: AnchoringOperation.REGISTER,
            status: AnchoringStatus.PENDING,
          },
        });
      }

      return created;
    });

    this.emitProofCreated(user.id, proof);
    return {
      proofId: proof.id,
      status: proof.status,
      verificationUrl: `/api/v1/proofs/${proof.id}/verify`,
      credential: this.signCredential(credential),
      anchoring: this.anchoringEnabled
        ? { anchored: false as const, reason: "pending" as const }
        : { anchored: false as const, reason: "disabled" as const },
    };
  }

  async revokeProof(userId: string, proofId: string) {
    const proof = await this.prisma.proof.findUnique({
      where: {
        id: proofId,
      },
      select: {
        id: true,
        userId: true,
        status: true,
        contractTransactionHash: true,
      },
    });

    if (!proof) {
      throw new NotFoundException("Proof not found");
    }

    if (proof.userId !== userId) {
      throw new ForbiddenException("Proof does not belong to this user");
    }

    // Write local revocation + optional REVOKE anchoring intent atomically.
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.proof.update({
        where: { id: proof.id },
        data: {
          status: ProofStatus.REVOKED,
          revokedAt: new Date(),
        },
        select: {
          id: true,
          status: true,
          revokedAt: true,
        },
      });

      // Only enqueue a REVOKE intent if the proof was previously anchored
      // on-chain — no on-chain registration means nothing to revoke.
      if (this.anchoringEnabled && proof.contractTransactionHash) {
        await tx.anchoringIntent.create({
          data: {
            proofId: proof.id,
            operation: AnchoringOperation.REVOKE,
            status: AnchoringStatus.PENDING,
          },
        });
      }

      return result;
    });

    const anchoringResult =
      this.anchoringEnabled && proof.contractTransactionHash
        ? { anchored: false as const, reason: "pending" as const }
        : { anchored: false as const, reason: "disabled" as const };

    this.emitWebhook(userId, "proof.revoked", {
      proofId: updated.id,
      status: updated.status,
      revokedAt: updated.revokedAt?.toISOString() ?? new Date().toISOString(),
    });

    return {
      ...updated,
      anchoring: anchoringResult,
    };
  }

  async verifyProof(
    proofId: string,
    clientContext?: VerificationClientContext,
  ) {
    this.verificationAbuseService?.checkClientCardinality(clientContext, proofId);
    const proof = await this.prisma.proof.findUnique({
      where: {
        id: proofId,
      },
      include: {
        user: {
          select: {
            walletHash: true,
          },
        },
        claim: true,
      },
    });

    this.verificationAbuseService?.checkVerification(
      clientContext,
      proofId,
      Boolean(proof?.claim),
    );

    if (!proof || !proof.claim) {
      // Unknown probes deliberately do not create audit rows: the identifier
      // is untrusted and could otherwise create an unbounded data sink.
      return {
        result: VerificationResult.UNKNOWN_PROOF,
        status: "unknown",
      };
    }

    const policy = this.jsonPolicy(proof.claim.disclosurePolicy);
    const cadence = this.revealCadence(proof.claim.frequency);
    const credential: EarnProofCredential =
      proof.proofType === ProofType.EMPLOYMENT_CONTINUITY
        ? this.rebuildEmploymentContinuityCredential({
            ...proof,
            claim: proof.claim,
          })
        : proof.proofType === ProofType.EMPLOYER_PAYMENT
        ? this.rebuildEmployerPaymentCredential({
            ...proof,
            claim: proof.claim,
          })
        : proof.proofType === ProofType.RECURRING_INCOME
        ? this.buildRecurringIncomeCredential({
            id: proof.id,
            walletHash: proof.user.walletHash,
            cadence: proof.claim.frequency ?? "invalid",
            intervalUnit: cadence?.intervalUnit ?? "month",
            intervalCount: cadence?.intervalCount ?? 0,
            assetCode: proof.assetCode,
            assetIssuer: proof.assetIssuer,
            periodStart: proof.periodStart ?? proof.createdAt,
            periodEnd: proof.periodEnd ?? proof.createdAt,
            qualifyingPaymentCount:
              typeof policy["qualifyingPaymentCount"] === "number"
                ? policy["qualifyingPaymentCount"]
                : 0,
            issuedAt: proof.createdAt,
            expiresAt: proof.expiresAt,
          })
        : proof.proofType === ProofType.PAYMENT_RECEIPT
          ? this.rebuildPaymentReceiptCredential({
              ...proof,
              claim: proof.claim!,
            })
          : this.buildCredential({
            id: proof.id,
            walletHash: proof.user.walletHash,
            thresholdAmount: this.revealThreshold(
              proof.claim.thresholdEncrypted,
            ),
            assetCode: proof.assetCode,
            assetIssuer: proof.assetIssuer,
            periodStart: proof.periodStart ?? proof.createdAt,
            periodEnd: proof.periodEnd ?? proof.createdAt,
            qualifyingPaymentCount: this.qualifyingPaymentCount(proof.claim),
            issuedAt: proof.createdAt,
            expiresAt: proof.expiresAt,
          });
    const signedCredential = this.signCredential(credential);
    const expectedHash = `sha256:${sha256(canonicalize(credential))}`;

    let result: VerificationResult = VerificationResult.VALID;
    if (proof.credentialHash !== expectedHash) {
      result = VerificationResult.INVALID_SIGNATURE;
    } else if (proof.status === ProofStatus.REVOKED) {
      result = VerificationResult.REVOKED;
    } else if (proof.expiresAt <= new Date()) {
      result = VerificationResult.EXPIRED;
    } else if (proof.status !== ProofStatus.ACTIVE) {
      result = VerificationResult.INVALID_SIGNATURE;
    }

    const contractStatus = proof.contractTransactionHash
      ? await this.contractAnchoringService?.getProofStatus(proof.id)
      : undefined;

    // Fail closed: authoritative on-chain invalidity overrides stale local state
    if (contractStatus?.checked) {
      if (contractStatus.revoked) {
        result = VerificationResult.REVOKED;
      } else if (result === VerificationResult.VALID && !contractStatus.valid) {
        result = VerificationResult.INVALID_SIGNATURE;
      }
    }

    // If required anchoring is enabled and this proof has not yet been
    // confirmed on-chain, return UNVERIFIED_ISSUER to signal that the proof
    // is not yet verifiable via the contract. Optional anchoring (or no
    // anchoring at all) does not block verification.
    if (
      result === VerificationResult.VALID &&
      this.anchoringRequired &&
      !proof.contractTransactionHash
    ) {
      result = VerificationResult.UNVERIFIED_ISSUER;
    }

    // Convert VerificationResult to VerificationOutcome for event recording
    const outcome = this.mapResultToOutcome(result);

    // Fail-open policy: record verification event asynchronously
    // If event recording fails, the verification response is still returned.
    // This ensures verification availability over audit completeness.
    // Event recording errors are caught and logged by the service.
    const verificationEventService = this.verificationEventService as VerificationEventService & {
      tryConsumePrivacyBudget?: (proofId: string) => boolean;
    };
    if (verificationEventService.tryConsumePrivacyBudget?.(proof.id) ?? true) {
      this.verificationEventService
        .recordEvent(outcome, proof.id, {
          outcome: outcome,
          timestamp: new Date(),
        })
        .catch(() => {
          // Error already logged by the service
          // Verification continues unblocked
        });

      await this.prisma.verificationEvent.create({
        data: {
          proofId: proof.id,
          result,
        },
      });
    }

    this.emitWebhook(proof.userId, "proof.verified", {
      proofId: proof.id,
      result,
      verifiedAt: new Date().toISOString(),
    });

    return {
      result,
      status: this.publicStatus(result),
      credential: signedCredential,
      proof: {
        id: proof.id,
        type: proof.proofType,
        schemaVersion: proof.schemaVersion,
        network: proof.network,
        issuedAt: proof.createdAt.toISOString(),
        expiresAt: proof.expiresAt.toISOString(),
        revokedAt: proof.revokedAt?.toISOString() ?? null,
        contractStatus: contractStatus ?? {
          checked: false,
          reason: "disabled",
        },
      },
    };
  }

  /**
   * Verify a bounded batch of proof IDs, returning one ordered result per
   * submitted ID.
   *
   * Each distinct ID runs through the exact single-proof {@link verifyProof}
   * path — same public (unauthenticated) access, same privacy envelope, same
   * event recording — so a batch reveals nothing a sequence of single calls
   * would not. Duplicate IDs are coalesced: the proof is looked up once (one
   * storage read, one anchoring check) and its verdict is returned at every
   * position it occupies, so a caller cannot multiply the fan-out by repeating
   * an ID. The four outcomes a relying party must distinguish — missing,
   * revoked, expired, and dependency-unavailable — are preserved per item via
   * `result` and `contractStatus`.
   */
  async verifyProofsBatch(proofIds: string[]) {
    const distinct = [...new Set(proofIds)];
    const byId = new Map<
      string,
      Awaited<ReturnType<ProofsService["verifyProof"]>>
    >();
    await Promise.all(
      distinct.map(async (id) => {
        byId.set(id, await this.verifyProof(id));
      }),
    );

    return {
      results: proofIds.map((id) => {
        const verified = byId.get(id)!;
        return {
          id,
          result: verified.result,
          status: verified.status,
          contractStatus: verified.proof?.contractStatus ?? {
            checked: false,
            reason: "unknown" as const,
          },
        };
      }),
    };
  }

  private emitProofCreated(
    userId: string,
    proof: {
      id: string;
      proofType: ProofType;
      schemaVersion: string;
      status: ProofStatus;
      network: string;
      assetCode: string;
      assetIssuer: string | null;
      periodStart: Date | null;
      periodEnd: Date | null;
      expiresAt: Date;
      credentialHash: string;
      contractTransactionHash?: string | null;
      createdAt: Date;
    },
  ) {
    this.emitWebhook(userId, "proof.created", {
      proofId: proof.id,
      proofType: proof.proofType,
      schemaVersion: proof.schemaVersion,
      status: proof.status,
      network: proof.network,
      assetCode: proof.assetCode,
      assetIssuer: proof.assetIssuer,
      periodStart: proof.periodStart?.toISOString() ?? null,
      periodEnd: proof.periodEnd?.toISOString() ?? null,
      expiresAt: proof.expiresAt.toISOString(),
      credentialHash: proof.credentialHash,
      contractTransactionHash: proof.contractTransactionHash ?? null,
      issuedAt: proof.createdAt.toISOString(),
    });
  }

  private emitWebhook(
    userId: string,
    event: "proof.created" | "proof.revoked" | "proof.verified",
    data: Record<string, unknown>,
  ) {
    this.webhookDeliveryService
      ?.enqueueForUser(userId, event, { event, data } as never)
      .catch(() => undefined);
  }

  private buildCredential(input: {
    id: string;
    walletHash: string;
    thresholdAmount: string;
    assetCode: string;
    assetIssuer: string | null;
    periodStart: Date;
    periodEnd: Date;
    qualifyingPaymentCount: number;
    issuedAt: Date;
    expiresAt: Date;
  }): MinimumIncomeCredential {
    return {
      id: input.id,
      type: "EarnProofMinimumIncomeCredential",
      schemaVersion: SCHEMA_VERSION,
      issuer: "earnproof-backend",
      subject: {
        walletHash: input.walletHash,
      },
      claim: {
        operator: "gte",
        thresholdAmount: input.thresholdAmount,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString(),
        qualifyingPaymentCount: input.qualifyingPaymentCount,
      },
      privacy: {
        exactIncomeHidden: true,
        sourceTransactionsHidden: true,
      },
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  private buildPaymentReceiptCredential(input: {
    id: string;
    walletHash: string;
    assetCode: string;
    assetIssuer: string | null;
    occurredAt: Date;
    paymentReferenceHash: string;
    senderHidden: boolean;
    amountHidden: boolean;
    sourceAddress?: string;
    amount?: string;
    issuedAt: Date;
    expiresAt: Date;
  }): PaymentReceiptCredential {
    return {
      id: input.id,
      type: "EarnProofPaymentReceiptCredential",
      schemaVersion: PAYMENT_RECEIPT_SCHEMA_VERSION,
      issuer: "earnproof-backend",
      subject: { walletHash: input.walletHash },
      claim: {
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        occurredAt: input.occurredAt.toISOString(),
        paymentReferenceHash: input.paymentReferenceHash,
        ...(input.senderHidden
          ? undefined
          : { sourceAddress: input.sourceAddress }),
        ...(input.amountHidden ? undefined : { amount: input.amount }),
      },
      privacy: {
        senderHidden: input.senderHidden,
        amountHidden: input.amountHidden,
      },
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  private buildRecurringIncomeCredential(input: {
    id: string;
    walletHash: string;
    cadence: string;
    intervalUnit: IntervalUnit;
    intervalCount: number;
    assetCode: string;
    assetIssuer: string | null;
    periodStart: Date;
    periodEnd: Date;
    qualifyingPaymentCount: number;
    issuedAt: Date;
    expiresAt: Date;
  }): RecurringIncomeCredential {
    return {
      id: input.id,
      type: "EarnProofRecurringIncomeCredential",
      schemaVersion: RECURRING_INCOME_SCHEMA_VERSION,
      issuer: "earnproof-backend",
      subject: { walletHash: input.walletHash },
      claim: {
        cadence: input.cadence,
        intervalUnit: input.intervalUnit,
        intervalCount: input.intervalCount,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString(),
        qualifyingPaymentCount: input.qualifyingPaymentCount,
      },
      privacy: {
        exactIncomeHidden: true,
        sourceTransactionsHidden: true,
      },
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  private buildEmploymentContinuityCredential(input: {
    id: string;
    walletHash: string;
    employerIssuerId: string;
    assetCode: string;
    assetIssuer: string | null;
    periodStart: Date;
    periodEnd: Date;
    periodUnit: string;
    observedPeriods: number;
    toleratedMissingPeriods: number;
    policyVersion: string;
    issuedAt: Date;
    expiresAt: Date;
  }): EmploymentContinuityCredential {
    return {
      id: input.id,
      type: "EarnProofEmploymentContinuityCredential",
      schemaVersion: EMPLOYMENT_CONTINUITY_SCHEMA_VERSION,
      issuer: "earnproof-backend",
      subject: { walletHash: input.walletHash },
      claim: {
        employerIssuerId: input.employerIssuerId,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString(),
        periodUnit: input.periodUnit,
        observedPeriods: input.observedPeriods,
        toleratedMissingPeriods: input.toleratedMissingPeriods,
        continuous: true,
        policyVersion: input.policyVersion,
      },
      privacy: {
        amountHidden: true,
        senderHidden: true,
        memoHidden: true,
        sourceTransactionsHidden: true,
        paymentDatesHidden: true,
      },
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  /**
   * Rebuilds a continuity credential purely from what was stored at issuance,
   * including the policy parameters. The current policy constants are never
   * consulted, so a later policy version cannot change what an issued proof
   * asserts; a tampered stored claim fails the canonical hash check.
   */
  private rebuildEmploymentContinuityCredential(proof: {
    id: string;
    assetCode: string;
    assetIssuer: string | null;
    createdAt: Date;
    expiresAt: Date;
    periodStart: Date | null;
    periodEnd: Date | null;
    user: { walletHash: string };
    claim: { disclosurePolicy: Prisma.JsonValue };
  }) {
    const policy = this.jsonPolicy(proof.claim.disclosurePolicy);
    const text = (key: string) =>
      typeof policy[key] === "string" ? (policy[key] as string) : "";
    const count = (key: string) =>
      typeof policy[key] === "number" ? (policy[key] as number) : -1;
    return this.buildEmploymentContinuityCredential({
      id: proof.id,
      walletHash: proof.user.walletHash,
      employerIssuerId: text("employerIssuerId"),
      assetCode: proof.assetCode,
      assetIssuer: proof.assetIssuer,
      periodStart: proof.periodStart ?? proof.createdAt,
      periodEnd: proof.periodEnd ?? proof.createdAt,
      periodUnit: text("periodUnit"),
      observedPeriods: count("observedPeriods"),
      toleratedMissingPeriods: count("toleratedMissingPeriods"),
      policyVersion: text("policyVersion"),
      issuedAt: proof.createdAt,
      expiresAt: proof.expiresAt,
    });
  }

  private continuityNotSatisfied() {
    return new UnprocessableEntityException({
      code: ApiErrorCode.CONTINUITY_NOT_SATISFIED,
      message:
        "Corroborated payments from this employer source do not satisfy the continuity policy for the requested window",
    });
  }

  private buildEmployerPaymentCredential(input: {
    id: string;
    walletHash: string;
    employerIssuerId: string;
    corroboration: EmployerCorroboration;
    assetCode: string;
    assetIssuer: string | null;
    periodStart: Date;
    periodEnd: Date;
    policyVersion: string;
    issuedAt: Date;
    expiresAt: Date;
  }): EmployerPaymentCredential {
    return {
      id: input.id,
      type: "EarnProofEmployerPaymentCredential",
      schemaVersion: EMPLOYER_PAYMENT_SCHEMA_VERSION,
      issuer: "earnproof-backend",
      subject: { walletHash: input.walletHash },
      claim: {
        employerIssuerId: input.employerIssuerId,
        corroboration: input.corroboration,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString(),
        periodBoundary: "start-inclusive-end-exclusive",
        paymentObserved: true,
        policyVersion: input.policyVersion,
      },
      privacy: {
        amountHidden: true,
        senderHidden: true,
        memoHidden: true,
        sourceTransactionsHidden: true,
      },
      issuedAt: input.issuedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    };
  }

  /**
   * Rebuilds an employer-payment credential from stored fields only. A claim
   * whose stored policy was altered produces a different canonical hash, so
   * verification reports it as invalid rather than trusting the JSON.
   */
  private rebuildEmployerPaymentCredential(proof: {
    id: string;
    assetCode: string;
    assetIssuer: string | null;
    createdAt: Date;
    expiresAt: Date;
    periodStart: Date | null;
    periodEnd: Date | null;
    user: { walletHash: string };
    claim: { disclosurePolicy: Prisma.JsonValue };
  }) {
    const policy = this.jsonPolicy(proof.claim.disclosurePolicy);
    const corroboration = policy["corroboration"];
    return this.buildEmployerPaymentCredential({
      id: proof.id,
      walletHash: proof.user.walletHash,
      employerIssuerId:
        typeof policy["employerIssuerId"] === "string"
          ? policy["employerIssuerId"]
          : "",
      corroboration:
        corroboration === "issuer_account" ||
        corroboration === "issuer_attestation"
          ? corroboration
          : "issuer_account",
      assetCode: proof.assetCode,
      assetIssuer: proof.assetIssuer,
      periodStart: proof.periodStart ?? proof.createdAt,
      periodEnd: proof.periodEnd ?? proof.createdAt,
      policyVersion:
        typeof policy["policyVersion"] === "string"
          ? policy["policyVersion"]
          : "",
      issuedAt: proof.createdAt,
      expiresAt: proof.expiresAt,
    });
  }

  /**
   * Loads one of the caller's trusted sources and resolves the employer
   * identity behind it. Unknown and non-owned sources are indistinguishable.
   */
  private async resolveTrustedEmployer(userId: string, trustedSourceId: string) {
    const source = await this.prisma.trustedSource.findFirst({
      where: { id: trustedSourceId, userId },
      select: {
        id: true,
        sourceAddress: true,
        status: true,
        issuerId: true,
        issuer: {
          select: {
            id: true,
            status: true,
            stellarAddress: true,
            organization: { select: { status: true } },
          },
        },
      },
    });
    if (!source) {
      throw new NotFoundException({
        code: ApiErrorCode.NOT_FOUND,
        message: "Trusted source not found",
      });
    }

    const addressOwner = await this.prisma.issuer.findUnique({
      where: { stellarAddress: source.sourceAddress },
      select: { id: true },
    });
    const resolution = resolveEmployerSource(source, addressOwner?.id ?? null);
    if (!resolution.ok) {
      throw this.employerSourceError(resolution.reason);
    }
    return { sourceId: source.id, resolution };
  }

  /**
   * Re-reads source, issuer and organization under FOR SHARE inside the
   * issuing transaction. The shared lock blocks a concurrent status change
   * until the transaction ends, and waits for one already in flight, so the
   * check sees the latest committed trust state.
   */
  private async assertEmployerStillTrusted(
    tx: Prisma.TransactionClient,
    sourceId: string,
    userId: string,
    resolution: Extract<EmployerSourceResolution, { ok: true }>,
  ) {
    const [locked] = await tx.$queryRaw<EmployerSourceLockRow[]>`
      SELECT
        ts."status" AS "sourceStatus",
        ts."sourceAddress" AS "sourceAddress",
        ts."issuerId" AS "issuerId",
        i."status" AS "issuerStatus",
        o."status" AS "organizationStatus"
      FROM "TrustedSource" ts
      JOIN "Issuer" i ON i."id" = ts."issuerId"
      JOIN "Organization" o ON o."id" = i."organizationId"
      WHERE ts."id" = ${sourceId} AND ts."userId" = ${userId}
      FOR SHARE OF ts, i, o
    `;
    if (
      !locked ||
      locked.sourceStatus !== ResourceStatus.ACTIVE ||
      locked.issuerStatus !== ResourceStatus.ACTIVE ||
      locked.organizationStatus !== ResourceStatus.ACTIVE ||
      locked.issuerId !== resolution.issuerId ||
      locked.sourceAddress !== resolution.sourceAddress
    ) {
      throw this.employerSourceError("source_inactive");
    }
  }

  /**
   * Active PAYMENT attestations from `issuerId` for the subject, keyed by the
   * payment reference hash they cover. When several cover the same payment
   * the lowest id wins, so the mapping is deterministic.
   */
  private async findPaymentAttestations(
    issuerId: string,
    subjectWalletHash: string,
    payments: ReadonlyArray<{ operationId: string }>,
    now: Date,
  ) {
    const attestationByReference = new Map<string, string>();
    if (payments.length === 0) return attestationByReference;

    const attestations = await this.prisma.attestation.findMany({
      where: {
        issuerId,
        subjectWalletHash,
        type: AttestationType.PAYMENT,
        status: ResourceStatus.ACTIVE,
        revokedAt: null,
        paymentReferenceHash: {
          in: payments.map((payment) =>
            this.paymentReferenceHash(payment.operationId),
          ),
        },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, paymentReferenceHash: true },
      orderBy: { id: "asc" },
    });
    for (const attestation of attestations) {
      if (
        attestation.paymentReferenceHash &&
        !attestationByReference.has(attestation.paymentReferenceHash)
      ) {
        attestationByReference.set(
          attestation.paymentReferenceHash,
          attestation.id,
        );
      }
    }
    return attestationByReference;
  }

  private employerSourceError(
    reason: Extract<EmployerSourceResolution, { ok: false }>["reason"],
  ) {
    // Messages are deliberately generic: they never echo addresses, issuer
    // ids or which specific check failed beyond the error code.
    if (reason === "ambiguous_issuer") {
      return new UnprocessableEntityException({
        code: ApiErrorCode.EMPLOYER_SOURCE_AMBIGUOUS,
        message: "The trusted source does not identify a single employer",
      });
    }
    return new UnprocessableEntityException({
      code: ApiErrorCode.EMPLOYER_SOURCE_UNTRUSTED,
      message:
        "The trusted source is not linked to an active, verified employer",
    });
  }

  /** Same reference format issuers use on PAYMENT attestations. */
  private paymentReferenceHash(operationId: string) {
    return `sha256:${sha256(operationId)}`;
  }

  private keyedDigest(value: string) {
    return `hmac-sha256:${createHmac("sha256", this.signingSecret)
      .update(value)
      .digest("base64url")}`;
  }

  private buildRecurringIntervals(
    periodStart: Date,
    periodEnd: Date,
    unit: IntervalUnit,
    count: number,
  ): Array<[Date, Date]> {
    const finalIntervalStart = this.addIntervalUnit(
      periodStart,
      unit,
      count - 1,
    );
    const cadenceEnd = this.addIntervalUnit(periodStart, unit, count);
    if (periodEnd < finalIntervalStart || periodEnd >= cadenceEnd) {
      throw new BadRequestException(
        "The overall period must contain exactly the requested number of cadence intervals",
      );
    }

    return Array.from({ length: count }, (_, index) => {
      const start = this.addIntervalUnit(periodStart, unit, index);
      const nextStart = this.addIntervalUnit(periodStart, unit, index + 1);
      const naturalEnd = new Date(nextStart.getTime() - 1);
      return [start, naturalEnd < periodEnd ? naturalEnd : periodEnd];
    });
  }

  private addIntervalUnit(date: Date, unit: IntervalUnit, amount: number) {
    const result = new Date(date);
    if (unit === "day") {
      result.setUTCDate(result.getUTCDate() + amount);
    } else if (unit === "week") {
      result.setUTCDate(result.getUTCDate() + amount * 7);
    } else {
      result.setUTCMonth(result.getUTCMonth() + amount);
    }
    return result;
  }

  private revealCadence(frequency: string | null) {
    const match = /^(day|week|month):([1-9]\d*)$/.exec(frequency ?? "");
    if (!match) return null;

    const intervalCount = Number(match[2]);
    if (!Number.isSafeInteger(intervalCount) || intervalCount > 120) {
      return null;
    }
    return {
      intervalUnit: match[1] as IntervalUnit,
      intervalCount,
    };
  }

  private rebuildPaymentReceiptCredential(proof: {
    id: string;
    assetCode: string;
    assetIssuer: string | null;
    createdAt: Date;
    expiresAt: Date;
    periodStart: Date | null;
    user: { walletHash: string };
    claim: {
      thresholdEncrypted: string | null;
      disclosurePolicy: Prisma.JsonValue;
    };
  }) {
    const policy = this.jsonPolicy(proof.claim.disclosurePolicy);
    const senderHidden = policy["senderHidden"] !== false;
    const amountHidden = policy["amountHidden"] !== false;
    const occurredAtValue = policy["occurredAt"];
    const occurredAt =
      typeof occurredAtValue === "string" &&
      !Number.isNaN(new Date(occurredAtValue).getTime())
        ? new Date(occurredAtValue)
        : (proof.periodStart ?? proof.createdAt);

    return this.buildPaymentReceiptCredential({
      id: proof.id,
      walletHash: proof.user.walletHash,
      assetCode: proof.assetCode,
      assetIssuer: proof.assetIssuer,
      occurredAt,
      paymentReferenceHash:
        typeof policy["paymentReferenceHash"] === "string"
          ? policy["paymentReferenceHash"]
          : "",
      senderHidden,
      amountHidden,
      sourceAddress:
        typeof policy["sourceAddress"] === "string"
          ? policy["sourceAddress"]
          : undefined,
      amount: amountHidden
        ? undefined
        : this.revealPaymentAmountForVerification(
            proof.claim.thresholdEncrypted,
          ),
      issuedAt: proof.createdAt,
      expiresAt: proof.expiresAt,
    });
  }

  private signCredential<T extends EarnProofCredential>(credential: T) {
    if (this.credentialVerificationKeyService) {
      return {
        ...credential,
        proof: this.credentialVerificationKeyService.signCredential(credential),
      };
    }

    const canonicalPayload = canonicalize(credential);
    return {
      ...credential,
      proof: {
        type: "HMAC-SHA256",
        credentialHash: `sha256:${sha256(canonicalPayload)}`,
        signature: `hmac-sha256:${createHmac("sha256", this.signingSecret)
          .update(canonicalPayload)
          .digest("base64url")}`,
      },
    };
  }

  private revealProtectedAmount(amountEncrypted: string | null) {
    if (!amountEncrypted) {
      throw new BadRequestException("Selected payment amount is unavailable");
    }

    try {
      return this.parseAmount(
        this.paymentEncryptionKeyring.decrypt(amountEncrypted),
      );
    } catch {
      throw new BadRequestException("Selected payment amount is unavailable");
    }
  }

  private revealPaymentAmount(amountEncrypted: string | null) {
    if (!amountEncrypted) {
      throw new UnprocessableEntityException({
        code: ApiErrorCode.PAYMENT_NOT_ELIGIBLE,
        message: "Payment amount is unavailable for disclosure",
      });
    }
    try {
      return this.paymentEncryptionKeyring.decrypt(amountEncrypted);
    } catch {
      throw new UnprocessableEntityException({
        code: ApiErrorCode.PAYMENT_NOT_ELIGIBLE,
        message: "Payment amount is unavailable for disclosure",
      });
    }
  }

  private revealPaymentAmountForVerification(amountEncrypted: string | null) {
    try {
      return amountEncrypted
        ? this.paymentEncryptionKeyring.decrypt(amountEncrypted)
        : "";
    } catch {
      return "";
    }
  }

  private jsonPolicy(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private revealThreshold(thresholdEncrypted: string | null) {
    if (!thresholdEncrypted?.startsWith("redacted:")) {
      return "0";
    }

    return Buffer.from(
      thresholdEncrypted.slice("redacted:".length),
      "base64url",
    ).toString("utf8");
  }

  private protectAmount(amount: string) {
    return `redacted:${Buffer.from(amount).toString("base64url")}`;
  }

  private parseAmount(amount: string) {
    const [whole, decimal = ""] = amount.split(".");
    const paddedDecimal = decimal.padEnd(7, "0");
    return BigInt(whole) * 10_000_000n + BigInt(paddedDecimal);
  }

  private qualifyingPaymentCount(claim: {
    disclosurePolicy: Prisma.JsonValue;
  }) {
    const policy = claim.disclosurePolicy;
    if (
      policy &&
      typeof policy === "object" &&
      !Array.isArray(policy) &&
      "qualifyingPaymentCount" in policy
    ) {
      const count = policy.qualifyingPaymentCount;
      return typeof count === "number" ? count : 1;
    }

    return 1;
  }

  private publicStatus(result: VerificationResult) {
    switch (result) {
      case VerificationResult.VALID:
        return "valid";
      case VerificationResult.EXPIRED:
        return "expired";
      case VerificationResult.REVOKED:
        return "revoked";
      case VerificationResult.UNKNOWN_PROOF:
        return "unknown";
      default:
        return "invalid";
    }
  }

  private mapResultToOutcome(result: VerificationResult): VerificationOutcome {
    switch (result) {
      case VerificationResult.VALID:
        return VerificationOutcome.VALID;
      case VerificationResult.EXPIRED:
        return VerificationOutcome.EXPIRED;
      case VerificationResult.REVOKED:
        return VerificationOutcome.REVOKED;
      case VerificationResult.INVALID_SIGNATURE:
        return VerificationOutcome.INVALID_SIGNATURE;
      case VerificationResult.UNKNOWN_PROOF:
        return VerificationOutcome.UNKNOWN;
      case VerificationResult.UNVERIFIED_ISSUER:
        return VerificationOutcome.ISSUER_WARNING;
      default:
        return VerificationOutcome.UNKNOWN;
    }
  }

  async getVerificationStats(userId: string, proofId: string) {
    // Verify proof ownership: only the owner or admin can view stats
    const proof = await this.prisma.proof.findUnique({
      where: {
        id: proofId,
      },
      select: {
        id: true,
        userId: true,
      },
    });

    if (!proof) {
      throw new NotFoundException("Proof not found");
    }

    if (proof.userId !== userId) {
      throw new ForbiddenException(
        "You do not have permission to view statistics for this proof",
      );
    }

    return this.verificationEventService.getAggregateStats(proofId);
  }

  private toHistoryItem(proof: Proof) {
    const expired = proof.expiresAt <= new Date();
    return {
      id: proof.id,
      type: proof.proofType,
      schemaVersion: proof.schemaVersion,
      localStatus: proof.status,
      credentialValidity: this.credentialValidity(proof, expired),
      expired,
      asset: { code: proof.assetCode, issuer: proof.assetIssuer },
      periodStart: proof.periodStart?.toISOString() ?? null,
      periodEnd: proof.periodEnd?.toISOString() ?? null,
      issuedAt: proof.createdAt.toISOString(),
      expiresAt: proof.expiresAt.toISOString(),
      revokedAt: proof.revokedAt?.toISOString() ?? null,
      anchoring: {
        anchored: Boolean(proof.contractTransactionHash),
        status: proof.contractTransactionHash ? "recorded" : "not_anchored",
        ...(proof.contractTransactionHash
          ? { transactionHash: proof.contractTransactionHash }
          : undefined),
        checked: false,
      },
    };
  }

  private credentialValidity(proof: Proof, expired: boolean) {
    if (proof.status === ProofStatus.REVOKED) return "revoked";
    if (proof.status === ProofStatus.INVALID) return "invalid";
    if (proof.status === ProofStatus.EXPIRED || expired) return "expired";
    return "valid";
  }

  private claimSummary(claim: ProofClaim | null) {
    if (!claim) return undefined;
    const policy = claim.disclosurePolicy as Prisma.JsonObject;
    const count = policy["qualifyingPaymentCount"];

    return {
      operator: claim.operator,
      result: claim.result,
      ...(typeof count === "number"
        ? { qualifyingPaymentCount: count }
        : undefined),
    };
  }

  private async proofAnchoringDetail(proof: Proof) {
    if (!proof.contractTransactionHash) {
      return { anchored: false, status: "not_anchored", checked: false };
    }

    if (!this.contractAnchoringService) {
      return {
        anchored: true,
        status: "recorded",
        transactionHash: proof.contractTransactionHash,
        checked: false,
      };
    }

    try {
      const contract = await this.contractAnchoringService.getProofStatus(
        proof.id,
      );
      return {
        anchored: true,
        status: contract.checked
          ? contract.revoked
            ? "revoked"
            : contract.valid
              ? "valid"
              : "invalid"
          : "unavailable",
        transactionHash: proof.contractTransactionHash,
        checked: contract.checked,
      };
    } catch {
      return {
        anchored: true,
        status: "unavailable",
        transactionHash: proof.contractTransactionHash,
        checked: false,
      };
    }
  }

  /**
   * Validate that all active attestations for a subject wallet are still valid
   * (not expired, not revoked) for proof issuance.
   *
   * This is called during proof creation to ensure attestation lifecycle requirements
   * are met before issuing credentials.
   *
   * @param subjectWalletHash Subject wallet hash
   * @returns true if all attestations are valid or no attestations exist
   */
  async validateSubjectAttestations(subjectWalletHash: string): Promise<boolean> {
    const attestations = await this.attestationsService.getValidAttestationsForSubject(
      subjectWalletHash,
    );

    // If no attestations exist, validation passes
    if (attestations.length === 0) {
      return true;
    }

    // All attestations must be valid (checked via getValidAttestationsForSubject)
    // which already filters for active status and non-expired/non-revoked states
    return attestations.length > 0;
  }

  /**
   * Check if an issuer's attestations for a subject are still valid.
   *
   * Used to gate proof issuance on issuer attestation status.
   *
   * @param issuerId Issuer ID
   * @param subjectWalletHash Subject wallet hash
   * @returns true if issuer has at least one valid attestation for subject
   */
  async hasValidAttestationsFromIssuer(
    issuerId: string,
    subjectWalletHash: string,
  ): Promise<boolean> {
    const attestations = await this.attestationsService.getValidAttestationsForSubject(
      subjectWalletHash,
      issuerId,
    );
    return attestations.length > 0;
  }
}
