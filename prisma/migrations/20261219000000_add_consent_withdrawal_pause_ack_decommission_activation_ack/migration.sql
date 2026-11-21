-- CreateEnum
CREATE TYPE "ConsentWithdrawalStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "PauseAcknowledgementActorRole" AS ENUM ('GUARDIAN', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "ContractLifecyclePhase" AS ENUM ('ACTIVE', 'GRACE', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "ProofActivationAckStatus" AS ENUM ('REQUIRED', 'COMPLETED');

-- CreateTable
CREATE TABLE "ConsentWithdrawal" (
    "id" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "disclosureReceiptId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "withdrawalCommitment" TEXT NOT NULL,
    "status" "ConsentWithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "transactionHash" TEXT,
    "failureCode" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PauseAcknowledgement" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "actorRole" "PauseAcknowledgementActorRole" NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "incidentCommitment" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PauseAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractDecommissionState" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "phase" "ContractLifecyclePhase" NOT NULL DEFAULT 'ACTIVE',
    "graceStartsAt" TIMESTAMP(3),
    "graceEndsAt" TIMESTAMP(3),
    "allowedCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "successorContractId" TEXT,
    "terminal" BOOLEAN NOT NULL DEFAULT false,
    "observedLedger" BIGINT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractDecommissionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofActivationAcknowledgement" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "requirementKey" TEXT NOT NULL,
    "requiredRole" TEXT NOT NULL,
    "status" "ProofActivationAckStatus" NOT NULL DEFAULT 'REQUIRED',
    "requiredLedger" INTEGER,
    "completedLedger" INTEGER,
    "completedAt" TIMESTAMP(3),
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProofActivationAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProofActivationProjection" (
    "proofId" TEXT NOT NULL,
    "observedLedger" INTEGER NOT NULL,
    "lastReconciledAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProofActivationProjection_pkey" PRIMARY KEY ("proofId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsentWithdrawal_disclosureReceiptId_key" ON "ConsentWithdrawal"("disclosureReceiptId");

-- CreateIndex
CREATE INDEX "ConsentWithdrawal_status_lastAttemptAt_idx" ON "ConsentWithdrawal"("status", "lastAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentWithdrawal_subjectUserId_idempotencyKey_key" ON "ConsentWithdrawal"("subjectUserId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PauseAcknowledgement_network_contractId_sequence_idx" ON "PauseAcknowledgement"("network", "contractId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "PauseAcknowledgement_network_contractId_eventId_key" ON "PauseAcknowledgement"("network", "contractId", "eventId");

-- CreateIndex
CREATE INDEX "ContractDecommissionState_phase_graceEndsAt_idx" ON "ContractDecommissionState"("phase", "graceEndsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContractDecommissionState_network_contractId_key" ON "ContractDecommissionState"("network", "contractId");

-- CreateIndex
CREATE INDEX "ProofActivationAcknowledgement_proofId_status_idx" ON "ProofActivationAcknowledgement"("proofId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProofActivationAcknowledgement_proofId_requirementKey_key" ON "ProofActivationAcknowledgement"("proofId", "requirementKey");

-- AddForeignKey
ALTER TABLE "ConsentWithdrawal" ADD CONSTRAINT "ConsentWithdrawal_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentWithdrawal" ADD CONSTRAINT "ConsentWithdrawal_disclosureReceiptId_fkey" FOREIGN KEY ("disclosureReceiptId") REFERENCES "DisclosureReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofActivationAcknowledgement" ADD CONSTRAINT "ProofActivationAcknowledgement_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofActivationProjection" ADD CONSTRAINT "ProofActivationProjection_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;

