-- Contract event cursor gap tracking (issue #423).

CREATE TYPE "ContractEventGapStatus" AS ENUM (
  'DETECTED',
  'BACKFILLING',
  'RESOLVED',
  'IRRECOVERABLE'
);

CREATE TABLE "ContractEventCursor" (
  "streamKey" TEXT NOT NULL,
  "highestSeenLedger" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContractEventCursor_pkey" PRIMARY KEY ("streamKey")
);

CREATE TABLE "ContractEventGap" (
  "id" TEXT NOT NULL,
  "streamKey" TEXT NOT NULL,
  "fromLedger" INTEGER NOT NULL,
  "toLedger" INTEGER NOT NULL,
  "status" "ContractEventGapStatus" NOT NULL DEFAULT 'DETECTED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failureReason" TEXT,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContractEventGap_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContractEventGap_range_check" CHECK ("fromLedger" <= "toLedger")
);

CREATE UNIQUE INDEX "ContractEventGap_streamKey_fromLedger_toLedger_key"
  ON "ContractEventGap"("streamKey", "fromLedger", "toLedger");
CREATE INDEX "ContractEventGap_status_streamKey_fromLedger_idx"
  ON "ContractEventGap"("status", "streamKey", "fromLedger");

CREATE TABLE "ContractEventApplied" (
  "streamKey" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "ledger" INTEGER NOT NULL,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContractEventApplied_pkey" PRIMARY KEY ("streamKey", "eventId")
);

CREATE INDEX "ContractEventApplied_streamKey_ledger_idx"
  ON "ContractEventApplied"("streamKey", "ledger");
