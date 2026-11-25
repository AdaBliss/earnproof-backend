import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthenticatedRoute } from "../common/decorators/authorization-policy.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { RequiredRole } from "../common/decorators/required-role.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { RoleGuard } from "../common/guards/role.guard";
import { SESSION_AUTH_SCHEME } from "../common/swagger/security-schemes";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  ListKeyCompromiseIncidentsDto,
  ResolveKeyCompromiseIncidentDto,
  RespondToKeyCompromiseDto,
} from "./dto/issuer-key-compromise.dto";
import { IssuerKeyCompromiseResponseService } from "./issuer-key-compromise-response.service";
import {
  IssuerSigningKeysService,
  RegisterSigningKeyDto,
} from "./issuer-signing-keys.service";

@ApiTags("issuer-signing-keys")
@AuthenticatedRoute({ ownership: "user" })
@ApiBearerAuth(SESSION_AUTH_SCHEME)
@UseGuards(AuthGuard)
@Controller("issuers/:id/signing-keys")
export class IssuerSigningKeysController {
  constructor(
    private readonly keysService: IssuerSigningKeysService,
    private readonly compromiseService: IssuerKeyCompromiseResponseService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List active and historical signing keys for an issuer",
  })
  async listKeys(@Param("id") issuerId: string) {
    return this.keysService.listKeys(issuerId);
  }

  @Post()
  @ApiOperation({
    summary: "Register a new signing key commitment for an issuer",
  })
  async registerKey(
    @Param("id") issuerId: string,
    @Body() dto: RegisterSigningKeyDto,
  ) {
    return this.keysService.registerKey(issuerId, dto);
  }

  @Post(":keyId/retire")
  @ApiOperation({ summary: "Retire a signing key upon rotation" })
  async retireKey(
    @Param("id") issuerId: string,
    @Param("keyId") keyId: string,
  ) {
    return this.keysService.retireKey(issuerId, keyId);
  }

  @Post(":keyId/compromise")
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary:
      "Report a signing key as compromised and run the coordinated response",
    description:
      "Admin-only. Marks the key COMPROMISED exactly once, revokes every ACTIVE trust pin for it (so it immediately fails verification policy), discovers affected records, opens a compromise incident, and notifies the issuer organization. Re-reporting the same key returns the existing incident unchanged: a compromised key can never be silently restored.",
  })
  async compromiseKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") issuerId: string,
    @Param("keyId") keyId: string,
    @Body() dto: RespondToKeyCompromiseDto,
  ) {
    return this.compromiseService.respondToCompromise({
      issuerId,
      keyId,
      actorId: user.id,
      organizationId: user.organizationId,
      reason: dto.reason,
    });
  }

  @Get("compromise-incidents")
  @ApiOperation({
    summary: "List compromise incidents for an issuer, newest first",
  })
  async listCompromiseIncidents(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") issuerId: string,
    @Query() query: ListKeyCompromiseIncidentsDto,
  ) {
    return this.compromiseService.listIncidents(
      issuerId,
      user.organizationId,
      query,
    );
  }

  @Get(":keyId/compromise-incident")
  @ApiOperation({
    summary: "Get the compromise incident for a signing key, if any",
  })
  async getCompromiseIncident(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") issuerId: string,
    @Param("keyId") keyId: string,
  ) {
    return this.compromiseService.getIncident(
      issuerId,
      keyId,
      user.organizationId,
    );
  }

  @Post(":keyId/compromise-incident/resolve")
  @UseGuards(AuthGuard, RoleGuard)
  @RequiredRole("ADMIN")
  @ApiOperation({
    summary: "Resolve a contained compromise incident with a recovery note",
    description:
      "Admin-only. Only CONTAINED incidents can be resolved, so resolution always carries the containment evidence (evidence hash, revocation and discovery counts).",
  })
  async resolveCompromiseIncident(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") issuerId: string,
    @Param("keyId") keyId: string,
    @Body() dto: ResolveKeyCompromiseIncidentDto,
  ) {
    const incident = await this.compromiseService.getIncident(
      issuerId,
      keyId,
      user.organizationId,
    );
    return this.compromiseService.resolveIncident({
      incidentId: incident.id,
      actorId: user.id,
      organizationId: user.organizationId,
      note: dto.note,
    });
  }
}
