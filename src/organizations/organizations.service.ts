import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ResourceStatus } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../database/prisma.service";
import { CreateOrganizationDto } from "./dto/create-organization.dto";
import { ListOrganizationsDto } from "./dto/list-organizations.dto";
import { OrganizationResponseDto } from "./dto/organization-response.dto";
import { UpdateOrganizationDto } from "./dto/update-organization.dto";
import { lifecycleStateOf } from "./organization-lifecycle.policy";

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrganization(
    user: AuthenticatedUser,
    input: CreateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    if (user.role !== "ADMIN") {
      throw new ForbiddenException("Only admins can create organizations");
    }

    // Check if slug already exists
    const existing = await this.prisma.organization.findUnique({
      where: { slug: input.slug },
    });

    if (existing) {
      throw new ConflictException(
        `Organization with slug "${input.slug}" already exists`,
      );
    }

    const org = await this.prisma.organization.create({
      data: {
        name: input.name,
        slug: input.slug,
        website: input.website || null,
        createdById: user.id,
        status: ResourceStatus.PENDING,
      },
    });

    // Log audit event
    await this.createAuditLog(user, "CREATE", "Organization", org.id, {
      name: org.name,
      slug: org.slug,
      website: org.website,
    });

    return this.toResponseDto(org);
  }

  async updateOrganization(
    user: AuthenticatedUser,
    organizationId: string,
    input: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    const current = await this.getVisibleOrganization(user, organizationId);
    if (current.archivedAt || current.deletedAt) {
      throw new ConflictException(
        "Organization is archived; restore it before changing its profile",
      );
    }

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(input.name && { name: input.name }),
        ...(input.website !== undefined && { website: input.website || null }),
      },
    });

    // Log audit event
    await this.createAuditLog(user, "UPDATE", "Organization", organizationId, {
      changes: input,
    });

    return this.toResponseDto(updated);
  }

  async getOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ): Promise<OrganizationResponseDto> {
    const org = await this.getVisibleOrganization(user, organizationId);
    const issuerCount = await this.prisma.issuer.count({
      where: { organizationId },
    });

    return {
      ...this.toResponseDto(org),
      issuerCount,
    };
  }

  async listOrganizations(
    user: AuthenticatedUser,
    query: ListOrganizationsDto,
  ): Promise<{
    items: OrganizationResponseDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) {
      where.status = query.status;
    }

    // Non-admins only see organizations they created
    if (user.role !== "ADMIN") {
      where.createdById = user.id;
    }

    const [items, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.organization.count({ where }),
    ]);

    const response = await Promise.all(
      items.map(async (org) => {
        const issuerCount = await this.prisma.issuer.count({
          where: { organizationId: org.id },
        });
        return {
          ...this.toResponseDto(org),
          issuerCount,
        };
      }),
    );

    return {
      items: response,
      total,
      page,
      limit,
    };
  }

  async getOrganizationById(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (!org) {
      throw new NotFoundException(
        `Organization with ID "${organizationId}" not found`,
      );
    }

    return org;
  }

  /**
   * Fetch ownership and existence in one scoped query. A non-admin receives
   * the same 404 for another tenant and for an absent/deleted resource, so a
   * denied request cannot become an existence oracle.
   */
  private async getVisibleOrganization(
    user: AuthenticatedUser,
    organizationId: string,
  ) {
    const org = await this.prisma.organization.findFirst({
      where: user.role === "ADMIN" ? { id: organizationId } : {
        id: organizationId,
        createdById: user.id,
      },
    });
    if (!org) throw new NotFoundException("Organization not found");
    return org;
  }

  private toResponseDto(org: any): OrganizationResponseDto {
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      website: org.website,
      status: org.status,
      createdById: org.createdById,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
      lifecycleState: lifecycleStateOf({
        archivedAt: org.archivedAt ?? null,
        deletedAt: org.deletedAt ?? null,
      }),
      archivedAt: org.archivedAt ?? null,
      legalHold: Boolean(org.legalHoldAt),
      deletedAt: org.deletedAt ?? null,
    };
  }

  private createAuditLog(
    user: AuthenticatedUser,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: any,
  ) {
    return this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        actorType: "User",
        action,
        resourceType,
        resourceId,
        metadata,
        createdAt: new Date(),
      },
    });
  }
}
