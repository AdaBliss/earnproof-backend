-- CreateEnum
CREATE TYPE "IssuerKeyCompromiseIncidentState" AS ENUM ('OPEN', 'CONTAINED', 'RESOLVED');

-- AlterEnum
ALTER TYPE "SecurityNotificationType" ADD VALUE 'ISSUER_SIGNING_KEY_COMPROMISED';

-- CreateTable
CREATE TABLE "IssuerKeyCompromiseIncident" (
    "id" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "signingKeyId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "state" "IssuerKeyCompromiseIncidentState" NOT NULL DEFAULT 'OPEN',
    "reason" VARCHAR(1024) NOT NULL,
    "reportedByUserId" TEXT NOT NULL,
    "compromisedAt" TIMESTAMP(3) NOT NULL,
    "commitmentHash" TEXT NOT NULL,
    "trustPinsRevoked" INTEGER NOT NULL DEFAULT 0,
    "affectedQuarantines" INTEGER NOT NULL DEFAULT 0,
    "affectedProofs" INTEGER NOT NULL DEFAULT 0,
    "discoveryTruncated" BOOLEAN NOT NULL DEFAULT false,
    "evidenceHash" TEXT,
    "containedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolutionNote" VARCHAR(1024),
    "notificationId" TEXT,
    "contractReconciledAt" TIMESTAMP(3),
    "contractReconciliationNote" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssuerKeyCompromiseIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssuerKeyCompromiseIncident_issuerId_keyId_key" ON "IssuerKeyCompromiseIncident"("issuerId", "keyId");
CREATE INDEX "IssuerKeyCompromiseIncident_state_createdAt_idx" ON "IssuerKeyCompromiseIncident"("state", "createdAt");
CREATE INDEX "IssuerKeyCompromiseIncident_issuerId_state_idx" ON "IssuerKeyCompromiseIncident"("issuerId", "state");

-- AddForeignKey
ALTER TABLE "IssuerKeyCompromiseIncident" ADD CONSTRAINT "IssuerKeyCompromiseIncident_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "Issuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuerKeyCompromiseIncident" ADD CONSTRAINT "IssuerKeyCompromiseIncident_signingKeyId_fkey" FOREIGN KEY ("signingKeyId") REFERENCES "IssuerSigningKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
