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
import { normalizeMemoDetailed } from "../stellar/memo-normalizer";
import { NormalizedMemo } from "../stellar/stellar.types";
import { StoredMemo, decodeStoredMemo, encodeStoredMemo } from "./payment-memo";

@Injectable()
export class PaymentsService {
  private readonly paymentEncryptionKeyring: PaymentEncryptionKeyringService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarService: StellarService,
    configService: ConfigService,
  ) {
    this.paymentEncryptionKeyring = new PaymentEncryptionKeyringService(
      configService,
    );
  }

  async syncPayments(user: { id: string; walletAddress: string }) {
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
    // Keyed by transaction: every operation in a transaction shares its memo,
    // and caching the encoded form keeps the stored value identical for all
    // of them.
    const memoCache = new Map<string, StoredMemo>();

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
          memoContext = encodeStoredMemo(
            normalizeMemoDetailed(transaction),
            this.paymentEncryptionKeyring,
          );
        } catch {
          enrichmentErrors += 1;
          memoContext = encodeStoredMemo(
            { memo: { type: "none" } },
            this.paymentEncryptionKeyring,
          );
        }
        memoCache.set(payment.stellarTransactionHash, memoContext);
      }

      const existing = existingOperationIds.has(payment.operationId);

      await this.prisma.payment.upsert({
        where: {
          operationId: payment.operationId,
        },
        update: {
          isEligible,
          occurredAt: payment.occurredAt,
          memo: memoContext as Prisma.InputJsonValue,
        },
        create: {
          userId: user.id,
          operationId: payment.operationId,
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
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        userId: user.id,
      },
      select: {
        id: true,
        classification: true,
        assetCode: true,
        assetIssuer: true,
        isEligible: true,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    const updated = await this.prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        classification,
      },
    });

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
          assetCode: payment.assetCode,
          assetIssuer: payment.assetIssuer,
          isEligible: payment.isEligible,
        },
      },
    });

    return this.toPaymentDto(updated);
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
      operationId: payment.operationId,
      stellarTransactionHash: payment.stellarTransactionHash,
      sourceAddress: payment.sourceAddress,
      destinationAddress: payment.destinationAddress,
      assetCode: payment.assetCode,
      assetIssuer: payment.assetIssuer,
      occurredAt: payment.occurredAt,
      classification: payment.classification,
      isEligible: payment.isEligible,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      memoContext: this.readMemoContext(payment.memo),
    };
  }

  private readMemoContext(memo: Prisma.JsonValue | null): NormalizedMemo {
    return decodeStoredMemo(memo, this.paymentEncryptionKeyring);
  }
}
