-- CreateEnum
CREATE TYPE "IssuerAssuranceLevel" AS ENUM ('NONE', 'BASIC', 'STANDARD', 'ENHANCED');

-- AlterTable
ALTER TABLE "Issuer" ADD COLUMN     "accreditationContractId" TEXT,
ADD COLUMN     "accreditationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "accreditationSyncedAt" TIMESTAMP(3),
ADD COLUMN     "accreditationTransactionHash" TEXT,
ADD COLUMN     "assuranceLevel" "IssuerAssuranceLevel" NOT NULL DEFAULT 'NONE';

-- CreateIndex
CREATE INDEX "Issuer_status_assuranceLevel_idx" ON "Issuer"("status", "assuranceLevel");

-- CreateIndex
CREATE INDEX "Issuer_assuranceLevel_accreditationExpiresAt_idx" ON "Issuer"("assuranceLevel", "accreditationExpiresAt");

-- CreateIndex
CREATE INDEX "Issuer_accreditationExpiresAt_idx" ON "Issuer"("accreditationExpiresAt");

