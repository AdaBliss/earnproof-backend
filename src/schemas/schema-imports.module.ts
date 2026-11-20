import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { SchemaImportsController } from "./schema-imports.controller";
import { SchemaImportsService } from "./schema-imports.service";
import { SchemaLifecycleController } from "./schema-lifecycle.controller";
import { SchemaLifecycleService } from "./schema-lifecycle.service";
import { SchemaReplacementController } from "./schema-replacement.controller";
import { SchemaReplacementService } from "./schema-replacement.service";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [
    SchemaImportsController,
    SchemaLifecycleController,
    SchemaReplacementController,
  ],
  providers: [
    SchemaImportsService,
    SchemaLifecycleService,
    SchemaReplacementService,
  ],
  exports: [SchemaImportsService, SchemaLifecycleService, SchemaReplacementService],
})
export class SchemaImportsModule {}
