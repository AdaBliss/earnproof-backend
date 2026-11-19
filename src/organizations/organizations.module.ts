import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { Clock, SystemClock } from "../common/time/clock";
import { DatabaseModule } from "../database/database.module";
import { OrganizationLifecycleController } from "./organization-lifecycle.controller";
import { OrganizationLifecycleService } from "./organization-lifecycle.service";
import { JobsModule } from "../jobs/jobs.module";
import { OrganizationsService } from "./organizations.service";
import { OrganizationsController } from "./organizations.controller";
import {
  EXPORT_ARTIFACT_STORE,
  FsExportArtifactStore,
} from "./exports/export-artifact-store";
import { OrganizationExportService } from "./exports/organization-export.service";
import { OrganizationExportWorkerService } from "./exports/organization-export.worker";
import {
  ExportDownloadController,
  OrganizationExportsController,
} from "./exports/organization-exports.controller";
import { OrganizationMembersService } from "./organization-members.service";
import { OrganizationMemberGuard } from "./guards/organization-member.guard";
import { OrganizationReadinessService } from "./organization-readiness.service";
import { MembershipImportService } from "./membership-import.service";
import { MembershipImportController } from "./membership-import.controller";
import { AccessReviewService } from "./access-review.service";
import { AccessReviewController } from "./access-review.controller";

/**
 * JobsModule is imported so the export worker and membership import jobs can record
 * their runs in the shared job-execution history (issue #201); the artifact store
 * is provided via a factory so its base directory comes from configuration and so
 * tests can swap in an in-memory implementation against the same token.
 * 
 * AuditModule is imported to support secret retrieval receipts for export tokens.
 */
@Module({
  imports: [DatabaseModule, AuthModule, AuditModule, JobsModule],
  controllers: [
    OrganizationsController,
    OrganizationLifecycleController,
    OrganizationExportsController,
    ExportDownloadController,
    MembershipImportController,
    AccessReviewController,
  ],
  providers: [
    OrganizationsService,
    OrganizationLifecycleService,
    OrganizationExportService,
    OrganizationExportWorkerService,
    OrganizationMembersService,
    OrganizationMemberGuard,
    OrganizationReadinessService,
    MembershipImportService,
    AccessReviewService,
    { provide: Clock, useClass: SystemClock },
    {
      provide: EXPORT_ARTIFACT_STORE,
      useClass: FsExportArtifactStore,
    },
  ],
  exports: [
    OrganizationsService,
    OrganizationLifecycleService,
    OrganizationExportService,
    OrganizationMembersService,
    MembershipImportService,
    AccessReviewService,
  ],
})
export class OrganizationsModule {}
