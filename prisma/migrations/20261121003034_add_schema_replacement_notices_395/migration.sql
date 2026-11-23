-- CreateEnum for SchemaReplacementStatus
CREATE TYPE "SchemaReplacementStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'ACTIONED', 'SUPERSEDED');

-- CreateEnum for SchemaReplacementAcknowledgementStatus
CREATE TYPE "SchemaReplacementAcknowledgementStatus" AS ENUM ('PENDING_ACTION', 'ACTED', 'DEFERRED');

-- CreateTable SchemaReplacementNotice
CREATE TABLE "SchemaReplacementNotice" (
    "id" TEXT NOT NULL,
    "predecessorSchemaId" TEXT NOT NULL,
    "successorSchemaId" TEXT NOT NULL,
    "status" "SchemaReplacementStatus" NOT NULL DEFAULT 'PENDING',
    "initiatedBy" TEXT NOT NULL,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deprecationDeadline" TIMESTAMP(3) NOT NULL,
    "sunsetDeadline" TIMESTAMP(3),
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchemaReplacementNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable SchemaReplacementAcknowledgement
CREATE TABLE "SchemaReplacementAcknowledgement" (
    "id" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "acknowledgedBy" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "SchemaReplacementAcknowledgementStatus" NOT NULL DEFAULT 'PENDING_ACTION',
    "actionTaken" TEXT,
    "actionAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchemaReplacementAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex for SchemaReplacementNotice
CREATE UNIQUE INDEX "SchemaReplacementNotice_predecessorSchemaId_successorSchemaId_st_key" ON "SchemaReplacementNotice"("predecessorSchemaId", "successorSchemaId", "status");
CREATE INDEX "SchemaReplacementNotice_status_deprecationDeadline_idx" ON "SchemaReplacementNotice"("status", "deprecationDeadline");
CREATE INDEX "SchemaReplacementNotice_predecessorSchemaId_status_idx" ON "SchemaReplacementNotice"("predecessorSchemaId", "status");
CREATE INDEX "SchemaReplacementNotice_successorSchemaId_status_idx" ON "SchemaReplacementNotice"("successorSchemaId", "status");
CREATE INDEX "SchemaReplacementNotice_initiatedAt_idx" ON "SchemaReplacementNotice"("initiatedAt");

-- CreateIndex for SchemaReplacementAcknowledgement
CREATE UNIQUE INDEX "SchemaReplacementAcknowledgement_noticeId_organizationId_key" ON "SchemaReplacementAcknowledgement"("noticeId", "organizationId");
CREATE INDEX "SchemaReplacementAcknowledgement_noticeId_status_idx" ON "SchemaReplacementAcknowledgement"("noticeId", "status");
CREATE INDEX "SchemaReplacementAcknowledgement_organizationId_status_idx" ON "SchemaReplacementAcknowledgement"("organizationId", "status");
CREATE INDEX "SchemaReplacementAcknowledgement_acknowledgedAt_idx" ON "SchemaReplacementAcknowledgement"("acknowledgedAt");

-- AddForeignKey for SchemaReplacementNotice
ALTER TABLE "SchemaReplacementNotice" ADD CONSTRAINT "SchemaReplacementNotice_predecessorSchemaId_fkey" FOREIGN KEY ("predecessorSchemaId") REFERENCES "ProtocolSchema"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SchemaReplacementNotice" ADD CONSTRAINT "SchemaReplacementNotice_successorSchemaId_fkey" FOREIGN KEY ("successorSchemaId") REFERENCES "ProtocolSchema"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey for SchemaReplacementAcknowledgement
ALTER TABLE "SchemaReplacementAcknowledgement" ADD CONSTRAINT "SchemaReplacementAcknowledgement_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "SchemaReplacementNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SchemaReplacementAcknowledgement" ADD CONSTRAINT "SchemaReplacementAcknowledgement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
