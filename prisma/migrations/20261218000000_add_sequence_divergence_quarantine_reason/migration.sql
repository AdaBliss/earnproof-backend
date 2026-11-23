-- Irrecoverable Stellar account sequence divergence is a visible terminal
-- quarantine reason (earnproof-backend#421).
ALTER TYPE "QuarantineReasonCode" ADD VALUE IF NOT EXISTS 'SEQUENCE_DIVERGENCE';
