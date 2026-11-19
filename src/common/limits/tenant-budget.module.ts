import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AuthModule } from "../../auth/auth.module";
import { TenantBudgetInterceptor } from "./tenant-budget.interceptor";
import { TenantBudgetService } from "./tenant-budget.service";

@Module({
  imports: [ConfigModule, AuthModule],
  providers: [
    TenantBudgetService,
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantBudgetInterceptor,
    },
  ],
  exports: [TenantBudgetService],
})
export class TenantBudgetModule {}
