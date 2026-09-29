import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { PrismaService } from "../database/prisma.service";
import { ApiErrorDto } from "../common/dto/api-error.dto";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import { CreateWebhookDto } from "./dto/create-webhook.dto";
import { UpdateWebhookEventsDto } from "./dto/update-webhook-events.dto";
import { UpdateWebhookCircuitConfigDto } from "./dto/webhook-circuit-config.dto";
import { WebhookCircuitStatsDto } from "./dto/webhook-circuit-stats.dto";
import { WebhooksService } from "./webhooks.service";
import { WebhookCircuitBreakerService } from "./webhook-circuit-breaker.service";

/**
 * Resolves the organisation ID from the current authenticated user.
 *
 * The JWT carries userId only.  We query the first ACTIVE organisation
 * the user belongs to.  In a multi-org scenario the org could be passed
 * as a path or query param — kept simple here per scope constraints.
 */
@ApiTags("webhooks")
@AuthenticatedRoute({ ownership: "user" })
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@ApiUnauthorizedResponse({
  description: "Missing, invalid, or expired session token.",
  type: ApiErrorDto,
})
@ApiForbiddenResponse({
  description:
    "The session is valid but belongs to no active organisation, or the "
    + "webhook belongs to another organisation.",
  type: ApiErrorDto,
})
@UseGuards(AuthGuard)
@Controller("webhooks")
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly circuitBreakerService: WebhookCircuitBreakerService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------------------------------
  // Endpoint management
  // ---------------------------------------------------------------------------

  @Post()
  @ApiOperation({
    summary: "Create a webhook endpoint",
    description:
      "Registers an HTTPS endpoint for the caller's organisation and returns its " +
      "signing secret. The secret is shown exactly once: store it before leaving " +
      "the response, and rotate the endpoint if it is lost.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      "Endpoint registered. `signingSecret` is returned once and never again.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.created", "proof.verified"],
        status: "ACTIVE",
        createdAt: "2026-08-24T12:00:00.000Z",
        signingSecret:
          "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "The URL is not HTTPS, or the event list is empty or names an unknown " +
      "event type.",
    type: ApiErrorDto,
  })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWebhookDto) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.create(orgId, dto);
  }

  @Get()
  @ApiOperation({
    summary: "List webhook endpoints for your organisation",
    description:
      "Returns every endpoint registered by the caller's organisation. Signing " +
      "secrets are never included.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Endpoints owned by the caller's organisation.",
    schema: {
      example: [
        {
          id: "ckv8v6h2b0002qzrm7t4k9xza",
          url: "https://example.com/webhooks/earnproof",
          events: ["proof.created", "proof.verified"],
          status: "ACTIVE",
          createdAt: "2026-08-24T12:00:00.000Z",
          updatedAt: "2026-08-24T12:00:00.000Z",
        },
      ],
    },
  })
  async list(@CurrentUser() user: AuthenticatedUser) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.listForOrg(orgId);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get a webhook endpoint",
    description: "Returns one endpoint owned by the caller's organisation.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "The endpoint.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.created", "proof.verified"],
        status: "ACTIVE",
        createdAt: "2026-08-24T12:00:00.000Z",
        updatedAt: "2026-08-24T12:00:00.000Z",
      },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.getForOrg(orgId, id);
  }

  @Patch(":id/events")
  @ApiOperation({
    summary: "Update event subscriptions",
    description:
      "Replaces the endpoint's subscription set. The list is a replacement, not " +
      "a delta: events omitted here stop being delivered.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Subscriptions replaced.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        url: "https://example.com/webhooks/earnproof",
        events: ["proof.revoked"],
        status: "ACTIVE",
        updatedAt: "2026-08-24T13:05:00.000Z",
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "The event list is empty or names an unknown event type.",
    type: ApiErrorDto,
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async updateEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() dto: UpdateWebhookEventsDto,
  ) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.updateEvents(orgId, id, dto);
  }

  @Post(":id/rotate-secret")
  @ApiOperation({
    summary: "Rotate the signing secret (returns new secret once)",
    description:
      "Issues a new signing secret and invalidates the old one immediately. " +
      "Deliveries already in flight fail their current attempt and are retried " +
      "with the new secret, so rotate before the old secret is discarded.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "New secret issued. Returned once and never again.",
    schema: {
      example: {
        webhookId: "ckv8v6h2b0002qzrm7t4k9xza",
        signingSecret:
          "3b1f6c0d9e5a4728b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d",
        rotatedAt: "2026-08-24T13:10:00.000Z",
        note:
          "Any in-flight deliveries signed with the old secret will fail their current attempt. They will be retried with the new secret.",
      },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async rotateSecret(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.rotateSecret(orgId, id);
  }

  @Patch(":id/disable")
  @ApiOperation({
    summary: "Disable a webhook endpoint",
    description:
      "Stops delivery without deleting the endpoint or its history. Reversible " +
      "with the enable route.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Endpoint disabled.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        status: "DISABLED",
        updatedAt: "2026-08-24T13:20:00.000Z",
      },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async disable(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.disable(orgId, id);
  }

  @Patch(":id/enable")
  @ApiOperation({
    summary: "Re-enable a webhook endpoint",
    description: "Resumes delivery for a previously disabled endpoint.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Endpoint re-enabled.",
    schema: {
      example: {
        id: "ckv8v6h2b0002qzrm7t4k9xza",
        status: "ACTIVE",
        updatedAt: "2026-08-24T13:25:00.000Z",
      },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async enable(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.enable(orgId, id);
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Delete a webhook endpoint",
    description:
      "Removes the endpoint. Disable it instead when the delivery history still " +
      "matters.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Endpoint deleted.",
    schema: {
      example: { deleted: true, webhookId: "ckv8v6h2b0002qzrm7t4k9xza" },
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async delete(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.delete(orgId, id);
  }

  // ---------------------------------------------------------------------------
  // Delivery observability
  // ---------------------------------------------------------------------------

  @Get(":id/deliveries")
  @ApiOperation({
    summary: "List delivery records for a webhook endpoint",
    description:
      "The 100 most recent delivery attempts, newest first. Request bodies and " +
      "signing headers are never stored, so nothing here can leak a secret.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Recent delivery attempts.",
    schema: {
      example: [
        {
          id: "ckv8v6h2b0003qzrm4d8n2plq",
          eventType: "proof.created",
          eventId: "evt_01hxk8s3n7q9v2m4c6d8e0f2g4",
          attempt: 1,
          status: "DELIVERED",
          statusCode: 200,
          responseBody: '{"ok":true}',
          durationMs: 142,
          failureReason: null,
          replayOf: null,
          replayedBy: null,
          deliveredAt: "2026-08-24T12:30:01.000Z",
          nextRetryAt: null,
          createdAt: "2026-08-24T12:30:00.000Z",
        },
      ],
    },
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async listDeliveries(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.listDeliveries(orgId, id);
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker management
  // ---------------------------------------------------------------------------

  @Get(":id/circuit")
  @ApiOperation({
    summary: "Get webhook circuit breaker statistics",
    description: "Returns current circuit state and failure statistics for monitoring.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Circuit breaker statistics.",
    type: WebhookCircuitStatsDto,
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async getCircuitStats(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const orgId = await this.requireOrgId(user);
    // Verify webhook ownership
    await this.webhooksService.getForOrg(orgId, id);
    
    const stats = await this.circuitBreakerService.getCircuitStats(id);
    if (!stats) {
      // Initialize circuit if it doesn't exist
      await this.circuitBreakerService.initializeCircuit(id);
      return await this.circuitBreakerService.getCircuitStats(id);
    }
    return stats;
  }

  @Patch(":id/circuit")
  @ApiOperation({
    summary: "Update webhook circuit breaker configuration",
    description: "Configure failure threshold and recovery window for circuit breaker.",
  })
  @ApiParam({
    name: "id",
    description: "Webhook endpoint identifier.",
    example: "ckv8v6h2b0002qzrm7t4k9xza",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Circuit breaker configuration updated.",
  })
  @ApiNotFoundResponse({
    description: "No such endpoint in the caller's organisation.",
    type: ApiErrorDto,
  })
  async updateCircuitConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() config: UpdateWebhookCircuitConfigDto,
  ) {
    const orgId = await this.requireOrgId(user);
    // Verify webhook ownership
    await this.webhooksService.getForOrg(orgId, id);
    
    await this.circuitBreakerService.updateConfig(id, config);
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Manual replay
  // ---------------------------------------------------------------------------

  @Post("deliveries/:deliveryId/replay")
  @ApiOperation({
    summary: "Manually replay a delivery (DEVELOPER or ADMIN only)",
    description:
      "Re-sends a stored delivery to its endpoint as a new attempt, keeping the " +
      "original event identifier so a receiver that de-duplicates on it can " +
      "recognise the replay. The replay is recorded against the acting user.",
  })
  @ApiParam({
    name: "deliveryId",
    description: "Delivery record to replay.",
    example: "ckv8v6h2b0003qzrm4d8n2plq",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: "Replay queued.",
    schema: {
      example: {
        replayDeliveryId: "ckv8v6h2b0004qzrm1s6y3wkc",
        originalDeliveryId: "ckv8v6h2b0003qzrm4d8n2plq",
        eventId: "evt_01hxk8s3n7q9v2m4c6d8e0f2g4",
        eventType: "proof.created",
        replayedBy: "ckv8v6h2b0000qzrmn831i7rn",
        replayedAt: "2026-08-24T14:00:00.000Z",
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      "The caller is not a DEVELOPER or ADMIN, or the delivery belongs to " +
      "another organisation.",
    type: ApiErrorDto,
  })
  @ApiNotFoundResponse({
    description: "No such delivery record.",
    type: ApiErrorDto,
  })
  async replayDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param("deliveryId") deliveryId: string,
  ) {
    this.requirePrivilegedRole(user);
    const orgId = await this.requireOrgId(user);
    return this.webhooksService.replayDelivery(orgId, deliveryId, user.id);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async requireOrgId(user: AuthenticatedUser): Promise<string> {
    // Find an active organization the user belongs to
    const userWithOrgs = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        organizations: {
          where: { status: "ACTIVE" },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!userWithOrgs?.organizations?.[0]) {
      throw new ForbiddenException("No active organisation found for this user");
    }

    return userWithOrgs.organizations[0].id;
  }

  private requirePrivilegedRole(user: AuthenticatedUser): void {
    if (user.role !== "DEVELOPER" && user.role !== "ADMIN") {
      throw new ForbiddenException(
        "Only DEVELOPER or ADMIN users may replay webhook deliveries",
      );
    }
  }
}
