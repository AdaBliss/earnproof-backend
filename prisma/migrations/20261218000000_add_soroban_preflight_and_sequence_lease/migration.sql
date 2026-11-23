-- CreateTable
CREATE TABLE "SourceAccountSequenceLease" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "holderToken" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "fencingCounter" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceAccountSequenceLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractSimulationRecord" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "proofIdHash" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT,
    "latestLedger" INTEGER,
    "minResourceFee" TEXT,
    "cpuInstructions" TEXT,
    "memoryBytes" TEXT,
    "authEntryCount" INTEGER,
    "restoreRequired" BOOLEAN NOT NULL DEFAULT false,
    "submittedTransactionHash" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractSimulationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceAccountSequenceLease_accountKey_key" ON "SourceAccountSequenceLease"("accountKey");

-- CreateIndex
CREATE INDEX "SourceAccountSequenceLease_expiresAt_idx" ON "SourceAccountSequenceLease"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContractSimulationRecord_correlationId_key" ON "ContractSimulationRecord"("correlationId");

-- CreateIndex
CREATE INDEX "ContractSimulationRecord_proofIdHash_idx" ON "ContractSimulationRecord"("proofIdHash");

-- CreateIndex
CREATE INDEX "ContractSimulationRecord_createdAt_idx" ON "ContractSimulationRecord"("createdAt");
