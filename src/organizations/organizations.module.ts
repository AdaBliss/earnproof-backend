import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { Clock, SystemClock } from "../common/time/clock";
import { DatabaseModule } from "../database/database.module";
import { OrganizationLifecycleController } from "./organization-lifecycle.controller";
import { OrganizationLifecycleService } from "./organization-lifecycle.service";
import { OrganizationsService } from "./organizations.service";
import { OrganizationsController } from "./organizations.controller";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [OrganizationsController, OrganizationLifecycleController],
  providers: [
    OrganizationsService,
    OrganizationLifecycleService,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [OrganizationsService, OrganizationLifecycleService],
})
export class OrganizationsModule {}
