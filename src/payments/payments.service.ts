import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Payment,
  PaymentClassification,
  Prisma,
  ResourceStatus,
} from "@prisma/client";
import { PaymentEncryptionKeyringService } from "../common/crypto/payment-encryption-keyring.service";
import { PrismaService } from "../database/prisma.service";
import { StellarService } from "../stellar/stellar.service";
import { normalizeMemo } from "../stellar/memo-normalizer";
import { operationIndexFromToid } from "../stellar/operation-identity";
import { NormalizedMemo } from "../stellar/stellar.types";
import { PaymentClassificationHistoryService } from "./payment-classification-history.service";

@Injectable()
export class PaymentsService {
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    private readonly classificationHistoryService: PaymentClassificationHistoryService,
  ) {
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(
      configService,
    );
  }

  async syncPayments(user: { id: string; walletAddress: string }) {
    // Resolved here rather than in the constructor: the network stamps every
    // synced payment's canonical identity, but classification-only call paths
    // never touch it, so requiring it at construction would over-couple them.
    const network = this.configService.getOrThrow<string>("stellar.network");
    const incomingPayments = await this.stellarService.fetchIncomingPayments(
      user.walletAddress,
    );
    const supportedAssets = await this.prisma.supportedAsset.findMany({
      where: {
        status: ResourceStatus.ACTIVE,
      },
      select: {
        code: true,
        issuer: true,
        network: true,
      },
    });
    const supportedAssetKeys = new Set(
      supportedAssets.map((asset) => this.assetKey(asset.code, asset.issuer)),
    );

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let enrichmentErrors = 0;
    let conflicts = 0;
    const memoCache = new Map<string, NormalizedMemo>();

    // Batch the "does this payment already exist" check into a single query
    // ahead of the loop, instead of one findUnique per incoming payment.
    // incomingPayments comes from Stellar Horizon and can run into the
    // hundreds for an active wallet; a query per row turned a sync into N+1
    // round trips to the database on top of the (already-batched) N calls to
    // Horizon for memo enrichment.
    const existingOperationIds = new Set(
      (
        await this.prisma.payment.findMany({
          where: {
            operationId: {
              in: incomingPayments.map((payment) => payment.operationId),
            },
          },
          select: { operationId: true },
        })
      ).map((row) => row.operationId),
    );

    for (const payment of incomingPayments) {
      const isEligible = supportedAssetKeys.has(
        this.assetKey(payment.assetCode, payment.assetIssuer),
      );

      if (!isEligible) {
        skipped += 1;
      }

      let memoContext = memoCache.get(payment.stellarTransactionHash);
      if (!memoContext) {
        try {
          const transaction = await this.stellarService.fetchTransaction(
            payment.stellarTransactionHash,
          );
          if (!transaction) {
            enrichmentErrors += 1;
          }
          memoContext = normalizeMemo(transaction);
        } catch {
          enrichmentErrors += 1;
          memoContext = { type: "none" };
        }
        memoCache.set(payment.stellarTransactionHash, memoContext);
      }

      const existing = existingOperationIds.has(payment.operationId);

      // The operation index comes from the operation id (a Horizon TOID) and,
      // with the network and transaction hash, forms the payment's canonical
      // identity. Persisting it lets two payment operations in the same
      // transaction remain distinct, and lets a reorg replay or a backfill key
      // on the same identity as the live sync.
      const operationIndex =
        payment.operationIndex ??
        operationIndexFromToid(payment.operationId);

      try {
        // Reprocessing the same operation is idempotent: the upsert keys on the
        // globally-unique operationId, so a replayed page updates the row in
        // place. The composite unique on (network, txHash, operationIndex)
        // rejects a genuinely conflicting duplicate — a different operationId
        // claiming an identity that already belongs to another row — which
        // surfaces here as P2002 and is counted rather than allowed to corrupt
        // the ledger or fail the whole sync.
        await this.prisma.payment.upsert({
          where: {
            operationId: payment.operationId,
          },
          update: {
            isEligible,
            occurredAt: payment.occurredAt,
            memo: memoContext as Prisma.InputJsonValue,
            network,
            operationIndex,
          },
          create: {
            userId: user.id,
            network,
            operationId: payment.operationId,
            operationIndex,
            stellarTransactionHash: payment.stellarTransactionHash,
            sourceAddress: payment.sourceAddress,
            destinationAddress: payment.destinationAddress,
            assetCode: payment.assetCode,
            assetIssuer: payment.assetIssuer,
            amountEncrypted: this.protectAmount(payment.amount),
            occurredAt: payment.occurredAt,
            memo: memoContext as Prisma.InputJsonValue,
            classification: PaymentClassification.UNKNOWN,
            isEligible,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          conflicts += 1;
          continue;
        }
        throw error;
      }

      if (existing) {
        updated += 1;
      } else {
        created += 1;
      }
    }

    return {
      totalFetched: incomingPayments.length,
      created,
      updated,
      skipped,
      enrichmentErrors,
      conflicts,
    };
  }

  async listPayments(
    userId: string,
    filters: { classification?: PaymentClassification; assetCode?: string },
  ) {
    const payments = await this.prisma.payment.findMany({
      where: {
        userId,
        classification: filters.classification,
        assetCode: filters.assetCode,
      },
      orderBy: {
        occurredAt: "desc",
      },
      take: 100,
    });

    return payments.map((payment) => this.toPaymentDto(payment));
  }

  async getPayment(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        userId,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    return this.toPaymentDto(payment);
  }

  async updateClassification(
    user: { id: string },
    paymentId: string,
    classification: PaymentClassification,
    reasonCode: string = "USER_RECLASSIFICATION",
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        userId: user.id,
      },
      select: {
        id: true,
        classification: true,
        classificationRevision: true,
        assetCode: true,
        assetIssuer: true,
        isEligible: true,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    // Skip update if classification is the same (no-op change)
    if (payment.classification === classification) {
      return this.toPaymentDto(
        await this.prisma.payment.findUniqueOrThrow({
          where: { id: paymentId },
        }),
      );
    }

    // Atomic transaction: update payment and create history record
    const result = await this.prisma.$transaction(async (tx) => {
      const newRevision = payment.classificationRevision + 1;

      // Update the payment with new classification and incremented revision
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          classification,
          classificationRevision: newRevision,
        },
      });

      // Create immutable history record
      await tx.paymentClassificationHistory.create({
        data: {
          paymentId: payment.id,
          actorId: user.id,
          previousClassification: payment.classification,
          newClassification: classification,
          reasonCode,
          classificationRevision: newRevision,
        },
      });

      return updatedPayment;
    });

    // Create audit log entry (outside transaction to avoid coupling)
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: user.id,
        action: "payment.classification.updated",
        resourceType: "payment",
        resourceId: payment.id,
        metadata: {
          previousClassification: payment.classification,
          nextClassification: classification,
          classificationRevision: result.classificationRevision,
          reasonCode,
          assetCode: payment.assetCode,
          assetIssuer: payment.assetIssuer,
          isEligible: payment.isEligible,
        },
      },
    });

    return this.toPaymentDto(result);
  }

  private assetKey(code: string, issuer: string | null) {
    return `${code}:${issuer ?? "native"}`;
  }

  private protectAmount(amount: string) {
    return this.paymentEncryptionKeyring.encrypt(amount);
  }

  private toPaymentDto(payment: Payment) {
    return {
      id: payment.id,
      network: payment.network,
      operationId: payment.operationId,
      operationIndex: payment.operationIndex,
      stellarTransactionHash: payment.stellarTransactionHash,
      sourceAddress: payment.sourceAddress,
      destinationAddress: payment.destinationAddress,
      assetCode: payment.assetCode,
      assetIssuer: payment.assetIssuer,
      occurredAt: payment.occurredAt,
      classification: payment.classification,
      classificationRevision: payment.classificationRevision,
      isEligible: payment.isEligible,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      memoContext: this.readMemoContext(payment.memo),
    };
  }

  private readMemoContext(memo: Prisma.JsonValue | null): NormalizedMemo {
    if (!memo || typeof memo !== "object" || Array.isArray(memo)) {
      return { type: "none" };
    }

    const stored = memo as Record<string, Prisma.JsonValue>;
    if (stored.type === "none") {
      return { type: "none" };
    }

    if (typeof stored.type !== "string" || typeof stored.value !== "string") {
      return { type: "none" };
    }

    if (stored.type === "text") {
      return {
        type: "text",
        value: Array.from(stored.value).slice(0, 500).join(""),
        truncated: stored.truncated === true,
      };
    }

    return normalizeMemo({
      memo_type: stored.type === "return_hash" ? "return" : stored.type,
      memo: stored.value,
    });
  }
}
