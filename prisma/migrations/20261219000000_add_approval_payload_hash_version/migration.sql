-- Record the version of the canonicalization/hash scheme that produced
-- ApprovalRequest.payloadHash (#384). Pre-existing rows were hashed with
-- the version-1 scheme, so the backfilled default of 1 keeps them
-- verifiable; verification of stored rows additionally accepts the
-- pre-redaction legacy hash for those rows (see verifyRequestBodyHash).
ALTER TABLE "ApprovalRequest" ADD COLUMN "payloadHashVersion" INTEGER NOT NULL DEFAULT 1;
