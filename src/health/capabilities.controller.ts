import { Controller, Get, Post, Body, Req, Res, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { CapabilityBitmapService } from '../contracts/capability-bitmap.service';
import {
  CheckCapabilityCompatibilityRequest,
  CapabilityCompatibilityResponse,
  CapabilityBitmapIndexMetadataResponse,
  ListCapabilitiesResponse,
  ListCapabilityVersionsResponse,
  CapabilityDefinitionResponse,
  CapabilityBitmapVersionResponse,
} from '../contracts/capability-bitmap.dto';

@Controller('api/v1/health/capabilities')
export class CapabilitiesController {
  constructor(private readonly capabilityService: CapabilityBitmapService) {}

  /**
   * GET /api/v1/health/capabilities
   * Returns the deployment's versioned capability document.
   * Includes feature flags, limits, deployment metadata, and a stable ETag.
   */
  @Get()
  getCapabilities(@Req() req: Request, @Res() res: Response) {
    const capabilityDoc = {
      version: '1.0.0',
      minClientVersion: '1.0.0',
      network: process.env.STELLAR_NETWORK || 'testnet',
      features: {
        webhooks: { concurrencyLimits: true, partitionOrdering: true },
        apiKeys: { cidrAllowlist: true },
        securityNotifications: { outboxDelivery: true },
        contracts: { capabilityBitmap: true, successorMigration: true },
      },
      limits: {
        maxWebhooksPerOrg: 10,
        defaultApiKeyRateLimit: 1000,
        maxCapabilityBitPosition: 63,
      },
      deploymentId: process.env.DEPLOYMENT_ID || 'earnproof-backend-prod',
    };

    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(capabilityDoc))
      .digest('hex');
    const etag = `"${hash}"`;

    if (req.headers['if-none-match'] === etag) {
      return res.status(HttpStatus.NOT_MODIFIED).send();
    }

    return res
      .setHeader('ETag', etag)
      .setHeader('Cache-Control', 'public, max-age=300, must-revalidate')
      .status(HttpStatus.OK)
      .json(capabilityDoc);
  }

  /**
   * GET /api/v1/health/capabilities/metadata
   * Returns metadata about the capability bitmap index (count, age, format version).
   */
  @Get('metadata')
  getCapabilityMetadata(): CapabilityBitmapIndexMetadataResponse {
    return this.capabilityService.getIndexMetadata();
  }

  /**
   * GET /api/v1/health/capabilities/definitions
   * Lists all capability definitions indexed in this deployment.
   */
  @Get('definitions')
  listCapabilityDefinitions(): ListCapabilitiesResponse {
    const capabilities = this.capabilityService.getAllCapabilities();
    return {
      total: capabilities.length,
      capabilities: capabilities.map((cap) => this.mapCapabilityDefinition(cap)),
    };
  }

  /**
   * GET /api/v1/health/capabilities/versions
   * Lists all capability bitmap versions defined for contract schema versions.
   */
  @Get('versions')
  listCapabilityVersions(): ListCapabilityVersionsResponse {
    const versions = this.capabilityService.getCapabilityVersions();
    return {
      total: versions.length,
      versions: versions.map((v) => this.mapCapabilityBitmapVersion(v)),
    };
  }

  /**
   * POST /api/v1/health/capabilities/check
   * Check if a contract with given schema version and capability bitmap
   * satisfies the requirements of a specific service.
   *
   * Request body:
   * {
   *   "serviceId": "webhook_sender",
   *   "schemaVersion": 2,
   *   "contractBitmap": "15"  // bigint as string
   * }
   *
   * Returns detailed compatibility findings with required vs. missing capabilities.
   */
  @Post('check')
  checkCompatibility(
    @Body() request: CheckCapabilityCompatibilityRequest,
  ): CapabilityCompatibilityResponse {
    // Parse bitmap from string (JSON-safe representation)
    let contractBitmap: bigint;
    try {
      contractBitmap = BigInt(request.contractBitmap);
    } catch {
      return {
        serviceId: request.serviceId,
        schemaVersion: request.schemaVersion,
        contractBitmap: request.contractBitmap,
        requiredCapabilities: [],
        hasCapabilities: [],
        missingCapabilities: [],
        missingAdvisory: [],
        compatible: false,
        reasonCode: 'invalid_bitmap',
        reason: 'contractBitmap must be a valid integer string',
      };
    }

    const check = this.capabilityService.checkCompatibility(
      request.serviceId,
      request.schemaVersion,
      contractBitmap,
    );

    return {
      serviceId: check.serviceId,
      schemaVersion: check.schemaVersion,
      contractBitmap: check.contractBitmap.toString(),
      requiredCapabilities: check.requiredCapabilities.map((c) =>
        this.mapCapabilityDefinition(c),
      ),
      hasCapabilities: check.hasCapabilities.map((c) =>
        this.mapCapabilityDefinition(c),
      ),
      missingCapabilities: check.missingCapabilities.map((c) =>
        this.mapCapabilityDefinition(c),
      ),
      missingAdvisory: check.missingAdvisory.map((c) =>
        this.mapCapabilityDefinition(c),
      ),
      compatible: check.compatible,
      reasonCode: check.reasonCode,
      reason: check.reason,
    };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private mapCapabilityDefinition(
    cap: any,
  ): CapabilityDefinitionResponse {
    return {
      bitPosition: cap.bitPosition,
      name: cap.name,
      description: cap.description,
      introducedInVersion: cap.introducedInVersion,
      severity: cap.severity,
      required: cap.required,
    };
  }

  private mapCapabilityBitmapVersion(v: any): CapabilityBitmapVersionResponse {
    return {
      schemaVersion: v.schemaVersion,
      bitmap: v.bitmap.toString(),
      definedAt: v.definedAt,
      capabilities: v.capabilities.map((c: any) =>
        this.mapCapabilityDefinition(c),
      ),
    };
  }
}
