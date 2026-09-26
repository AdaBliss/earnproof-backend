import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ApiKeyScope, ResourceStatus } from "@prisma/client";
import { randomBytes, timingSafeEqual } from "crypto";
import { sha256 } from "../common/crypto/hash";
import { PrismaService } from "../database/prisma.service";

/**
 * API Key Service - Secure credential management for machine-to-machine integrations.
 *
 * SECURITY POSTURE: This service implements constant-time verification to prevent timing attacks
 * on secret authentication. See verifySecret() for detailed constant-time design.
 *
 * Design decisions:
 *
 * 1. Hashing algorithm: SHA-256 (fast cryptographic hash, not bcrypt)
 *    - API keys are high-entropy random secrets (32 bytes), not weak human passwords
 *    - SHA-256 is the standard for API key hashing in industry (e.g., GitHub, Stripe)
 *    - bcrypt's slow-hash design is for defending against brute-force on weak passwords
 *    - Against brute-force on high-entropy random secrets, SHA-256 + salt is sufficient
 *    - This codebase already uses SHA-256 for other credentials (proof hashes, wallet hashes)
 *    - Reasoning: consistent with existing patterns, appropriate for threat model
 *
 * 2. Key format: 32 bytes (256 bits) of randomness, base64url-encoded
 *    - Yields ~43 characters when encoded
 *    - Prefix: first 8 characters (32 bits of entropy for human recognition)
 *    - Sufficient entropy for cryptographic security
 *
 * 3. Secret display: returned ONCE on creation/rotation, never stored/retrievable
 *    - API key lifecycle: generate → hash → store hash+prefix → display secret once → never again
 *    - No code path can reconstruct or re-display the raw secret
 *
 * 4. Organization isolation: enforced at query level, not surface-level checks
 *    - Every lookup includes organizationId filter
 *    - Cannot list/rotate/revoke another org's keys even with valid token
 *
 * 5. Audit logging: records administrative actions (create, rotate, revoke, use)
 *    - Never logs raw secrets or hashes
 *    - Logs only non-sensitive identifiers: keyId, prefix, organizationId, actor
 *    - Timestamps and action types for complete audit trail
 *
 * 6. Constant-time verification: prevents timing side-channel attacks
 *    - All verification attempts follow identical code paths regardless of input format
 *    - Format validation does not short-circuit before cryptographic comparison
 *    - See verifySecret() for implementation details
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);
  private readonly KEY_BYTES = 32;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a new cryptographically strong API key secret.
   *
   * @returns Object with raw secret (display once) and prefix (for storage/display in listings)
   */
  generateSecret(): {
    secret: string;
    prefix: string;
  } {
    const randomBytes32 = randomBytes(this.KEY_BYTES);
    const secret = randomBytes32.toString("base64url");
    const prefix = secret.substring(0, 8);

    return { secret, prefix };
  }

  /**
   * Hash a raw API key secret for storage.
   * Uses SHA-256: appropriate for high-entropy API keys.
   *
   * @param secret - The raw secret (display only, never logged)
   * @returns SHA-256 hash as hex string
   */
  hashSecret(secret: string): string {
    return sha256(secret);
  }

  /**
   * Verify a presented secret against a stored hash.
   * Returns true if they match (constant-time comparison).
   *
   * SECURITY: This method is designed to execute in constant time regardless of:
   *   - Whether storedHash is correctly formatted
   *   - Whether storedHash matches the computed hash
   *   - Input lengths or validity
   *
   * Timing attacks exploit variable execution time to infer information about
   * secrets or hash formats. This implementation prevents timing leakage by:
   *   1. Computing the hash of the presented secret (unavoidable baseline work)
   *   2. Performing format validation in constant time (not regex, which short-circuits)
   *   3. Always attempting decoding and comparison regardless of format validity
   *   4. Using a dummy buffer if decoding fails (ensures same execution path)
   *   5. Using timingSafeEqual for the final comparison (Node.js crypto primitive)
   *
   * Malformed inputs (invalid hex, wrong length, etc.) follow the same codepath
   * as valid-format inputs, ensuring no timing distinction.
   *
   * @param secret - Presented secret from client
   * @param storedHash - Stored hash from database (expected: 64 hex chars)
   * @returns true if secret hashes to storedHash, false otherwise
   */
  verifySecret(secret: string, storedHash: string): boolean {
    const computedHash = this.hashSecret(secret);
    const computedBuffer = Buffer.from(computedHash, "hex");

    // Constant-time format validation: check length and character validity
    // without short-circuiting. SHA-256 hashes are exactly 64 hex characters.
    const EXPECTED_HEX_LENGTH = 64;
    let isValidFormat = true;

    // Check length in constant time
    if (storedHash.length !== EXPECTED_HEX_LENGTH) {
      isValidFormat = false;
    }

    // Check each character is valid hex [a-fA-F0-9] in constant time
    // Do NOT use early returns or short-circuit logic
    for (let i = 0; i < EXPECTED_HEX_LENGTH; i++) {
      const char = storedHash.charCodeAt(i);
      // Check if char is 0-9 (48-57), a-f (97-102), or A-F (65-70)
      const isDigit = char >= 48 && char <= 57;
      const isLowerHex = char >= 97 && char <= 102;
      const isUpperHex = char >= 65 && char <= 70;
      if (!(isDigit || isLowerHex || isUpperHex)) {
        isValidFormat = false;
      }
    }

    // Decode hex to buffer, using dummy if format is invalid
    // This ensures all inputs follow the same comparison path
    let storedBuffer: Buffer;
    try {
      // Buffer.from() with 'hex' encoding will throw if the string contains
      // invalid hex characters or has odd length. We catch and use dummy.
      storedBuffer = Buffer.from(storedHash, "hex");
      // Additional safety: verify the decoded buffer is the correct length
      if (storedBuffer.length !== 32) {
        // Not 32 bytes (256 bits), which SHA-256 always produces
        storedBuffer = Buffer.alloc(32);
      }
    } catch {
      // Decoding failed: use dummy buffer of correct length (32 bytes)
      // This ensures timing is identical whether parsing succeeds or fails
      storedBuffer = Buffer.alloc(32);
    }

    // Compare in constant time using Node.js crypto primitive
    try {
      return timingSafeEqual(computedBuffer, storedBuffer);
    } catch {
      // timingSafeEqual only throws if buffer lengths differ.
      // This should not occur given our allocation strategy, but guard anyway.
      return false;
    }
  }

  /**
   * Look up an API key by prefix to narrow the search space,
   * then verify the full secret against the stored hash.
   *
   * This is more efficient than hashing the presented secret and
   * scanning all stored hashes. Prefix is not secret (8 chars from a 43-char key).
   *
   * @param prefix - First 8 characters of the presented key (non-secret)
   * @param secret - Full presented secret (secret)
   * @param organizationId - Organization scope for isolation
   * @returns ApiKey record if valid, null if not found/invalid/revoked/expired
   */
  async lookupAndVerifyKey(
    prefix: string,
    secret: string,
    organizationId: string,
  ) {
    // Lookup by prefix + organization (narrow scope quickly)
    const apiKey = await this.prisma.apiKey.findFirst({
      where: {
        prefix,
        organizationId,
        status: ResourceStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        // An archived or deleted organization's keys stop authenticating the
        // moment it is archived; they start again only if it is restored.
        organization: { archivedAt: null },
      },
      include: {
        scopeAssignments: {
          select: {
            scope: true,
          },
        },
        organization: {
          select: {
            id: true,
            slug: true,
          },
        },
      },
    });

    if (!apiKey) {
      return null; // Not found, revoked, expired, or wrong org
    }

    // Verify the full secret matches stored hash
    const isValid = this.verifySecret(secret, apiKey.keyHash);
    if (!isValid) {
      return null; // Hash mismatch (wrong secret)
    }

    return apiKey;
  }

  /**
   * Create a new API key for an organization.
   *
   * @param input - Creation parameters
   * @returns Object with raw secret (display once) and stored key metadata
   */
  async createKey(input: {
    organizationId: string;
    createdBy: string;
    name: string;
    scopes?: ApiKeyScope[];
    expiresAt?: Date;
  }) {
    const { secret, prefix } = this.generateSecret();
    const keyHash = this.hashSecret(secret);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        organizationId: input.organizationId,
        createdById: input.createdBy,
        name: input.name,
        prefix,
        keyHash,
        expiresAt: input.expiresAt,
        scopeAssignments: input.scopes
          ? {
              createMany: {
                data: input.scopes.map((scope) => ({ scope })),
              },
            }
          : undefined,
      },
      include: {
        scopeAssignments: {
          select: {
            scope: true,
          },
        },
      },
    });

    // Audit log: API key created (never log secret or hash)
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: input.createdBy,
        action: "api_key.created",
        resourceType: "api_key",
        resourceId: apiKey.id,
        metadata: {
          prefix: apiKey.prefix,
          name: apiKey.name,
          organizationId: apiKey.organizationId,
          scopes: apiKey.scopeAssignments.map((sa) => sa.scope),
          expiresAt: apiKey.expiresAt?.toISOString(),
        },
      },
    });

    return {
      secret, // Display ONCE - never stored, never retrievable
      apiKey: {
        id: apiKey.id,
        prefix: apiKey.prefix,
        name: apiKey.name,
        status: apiKey.status,
        scopes: apiKey.scopeAssignments.map((sa) => sa.scope),
        createdAt: apiKey.createdAt,
        expiresAt: apiKey.expiresAt,
      },
    };
  }

  /**
   * Rotate an API key: generate new secret, invalidate old one immediately.
   * Key ID remains stable so references in client code don't break.
   *
   * @param keyId - ID of key to rotate
   * @param organizationId - Organization scope
   * @returns New secret and updated key metadata
   */
  async rotateKey(keyId: string, organizationId: string, actorId?: string) {
    const { secret, prefix } = this.generateSecret();
    const keyHash = this.hashSecret(secret);

    const apiKey = await this.prisma.apiKey.update({
      where: { id: keyId, organizationId },
      data: {
        prefix,
        keyHash,
        rotatedAt: new Date(),
      },
      include: {
        scopeAssignments: {
          select: {
            scope: true,
          },
        },
      },
    });

    // Verify organization ownership
    if (apiKey.organizationId !== organizationId) {
      throw new ForbiddenException("Key does not belong to this organization");
    }

    // Audit log: API key rotated (never log secrets or hashes)
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: actorId ?? null,
        action: "api_key.rotated",
        resourceType: "api_key",
        resourceId: apiKey.id,
        metadata: {
          prefix: apiKey.prefix,
          name: apiKey.name,
          organizationId: apiKey.organizationId,
          rotatedAt: apiKey.rotatedAt?.toISOString(),
        },
      },
    });

    return {
      secret, // Display ONCE - new secret invalidates old immediately
      apiKey: {
        id: apiKey.id,
        prefix: apiKey.prefix,
        name: apiKey.name,
        status: apiKey.status,
        scopes: apiKey.scopeAssignments.map((sa) => sa.scope),
        rotatedAt: apiKey.rotatedAt,
      },
    };
  }

  /**
   * Revoke an API key: mark as REVOKED, take effect immediately.
   *
   * @param keyId - ID of key to revoke
   * @param organizationId - Organization scope
   * @param actorId - User performing the revocation
   */
  async revokeKey(keyId: string, organizationId: string, actorId?: string) {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { id: keyId, organizationId },
      select: {
        organizationId: true,
        prefix: true,
        name: true,
      },
    });

    if (!apiKey) {
      throw new NotFoundException("Key not found");
    }

    await this.prisma.apiKey.update({
      where: { id: keyId, organizationId },
      data: {
        status: ResourceStatus.REVOKED,
        revokedAt: new Date(),
      },
    });

    // Audit log: API key revoked
    await this.prisma.auditLog.create({
      data: {
        actorType: "user",
        actorId: actorId ?? null,
        action: "api_key.revoked",
        resourceType: "api_key",
        resourceId: keyId,
        metadata: {
          prefix: apiKey.prefix,
          name: apiKey.name,
          organizationId: apiKey.organizationId,
          revokedAt: new Date().toISOString(),
        },
      },
    });
  }

  /**
   * List all API keys for an organization (metadata only, no secrets).
   *
   * @param organizationId - Organization to list keys for
   * @returns List of key metadata (id, prefix, name, status, scopes, dates)
   */
  async listKeysForOrganization(organizationId: string) {
    return this.prisma.apiKey.findMany({
      where: {
        organizationId,
      },
      select: {
        id: true,
        prefix: true,
        name: true,
        status: true,
        scopeAssignments: {
          select: {
            scope: true,
          },
        },
        createdAt: true,
        rotatedAt: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  /**
   * Record that an API key was used (for lastUsedAt tracking).
   * Non-identifying timestamp only (no IP, no user-agent).
   * Also logs successful key authentication to audit trail.
   *
   * @param keyId - Key that was used
   * @param organizationId - Organization the key belongs to
   */
  async recordKeyUsage(keyId: string, organizationId?: string) {
    try {
      const updated = await this.prisma.apiKey.update({
        where: { id: keyId },
        data: {
          lastUsedAt: new Date(),
        },
        select: {
          prefix: true,
          name: true,
          organizationId: true,
        },
      });

      // Audit log: API key used (successful authentication)
      if (organizationId && organizationId === updated.organizationId) {
        await this.prisma.auditLog.create({
          data: {
            actorType: "api_key",
            actorId: keyId, // The API key itself is the actor
            action: "api_key.authenticated",
            resourceType: "api_key",
            resourceId: keyId,
            metadata: {
              prefix: updated.prefix,
              organizationId: updated.organizationId,
              timestamp: new Date().toISOString(),
            },
          },
        });
      }
    } catch {
      // Log but don't throw - usage tracking shouldn't block requests
      this.logger.warn(`Failed to record API key usage for ${keyId}`);
    }
  }
}
