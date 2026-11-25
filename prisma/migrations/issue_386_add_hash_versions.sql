-- Migration: Add token hash versioning for issue #386
-- 
-- Adds tokenHashVersion columns to all opaque token tables.
-- Existing rows default to v1 (SHA-256) for backward compatibility.
-- 
-- New tokens created after this migration use the current version (v2 PBKDF2).
-- On successful verification, old-version tokens are progressively upgraded.

-- Add tokenHashVersion to AuthSession
ALTER TABLE "AuthSession" 
ADD COLUMN "tokenHashVersion" INTEGER NOT NULL DEFAULT 1;

-- Add tokenHashVersion to RecentAuthAssertion
ALTER TABLE "RecentAuthAssertion" 
ADD COLUMN "tokenHashVersion" INTEGER NOT NULL DEFAULT 1;

-- Add tokenHashVersion to ProofShareToken
ALTER TABLE "ProofShareToken" 
ADD COLUMN "tokenHashVersion" INTEGER NOT NULL DEFAULT 1;

-- Create indexes for efficient weak-version queries and cleanup
CREATE INDEX "idx_auth_session_hash_version_expiry" 
ON "AuthSession"("tokenHashVersion", "expiresAt") 
WHERE "tokenHashVersion" < 2;

CREATE INDEX "idx_recent_auth_assertion_hash_version_expiry" 
ON "RecentAuthAssertion"("tokenHashVersion", "expiresAt") 
WHERE "tokenHashVersion" < 2;

CREATE INDEX "idx_proof_share_token_hash_version_expiry" 
ON "ProofShareToken"("tokenHashVersion", "expiresAt") 
WHERE "tokenHashVersion" < 2;

-- Indexes for progressive upgrade: find old-version tokens for a given user
CREATE INDEX "idx_auth_session_hash_version_user" 
ON "AuthSession"("userId", "tokenHashVersion") 
WHERE "tokenHashVersion" < 2 AND "revokedAt" IS NULL;

-- Optional: Track migration progress via audit log
-- (Assumes an AuditLog table exists; adjust if different)
-- INSERT INTO "AuditLog"(
--   "actorType", "action", "resourceType", "resourceId",
--   "metadata", "chainKey", "createdAt"
-- ) VALUES (
--   'system', 'migration_applied', 'hashing', 'issue_386_add_hash_versions',
--   jsonb_build_object(
--     'tables_updated', array['AuthSession', 'RecentAuthAssertion', 'ProofShareToken'],
--     'default_version', 1,
--     'notes', 'Existing tokens default to v1 for backward compatibility'
--   ),
--   'SYSTEM',
--   NOW()
-- );
