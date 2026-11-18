import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { MigrationLeaseService } from "./migration-lease.service";
import { DatabaseTimeoutService } from "./database-timeout.service";

@Global()
@Module({
  providers: [PrismaService, MigrationLeaseService, DatabaseTimeoutService],
  exports: [PrismaService, MigrationLeaseService, DatabaseTimeoutService],
})
export class DatabaseModule {}
