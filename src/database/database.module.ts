import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { MigrationLeaseService } from "./migration-lease.service";
import { TenantContextService } from "./tenant-context.service";
import { DistributedLeaseService } from "../jobs/distributed-lease.service";
import { TransactionRetryService } from "./transaction-retry.service";

@Global()
@Module({
  providers: [PrismaService, MigrationLeaseService, DistributedLeaseService, TenantContextService],
  exports: [PrismaService, MigrationLeaseService, DistributedLeaseService, TenantContextService],
})
export class DatabaseModule {}
