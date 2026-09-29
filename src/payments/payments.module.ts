import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StellarModule } from "../stellar/stellar.module";
import { PaymentBackfillService } from "./payment-backfill.service";
import { PaymentBackfillsController } from "./payment-backfills.controller";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PaymentClassificationHistoryService } from "./payment-classification-history.service";

@Module({
  imports: [AuthModule, StellarModule],
  controllers: [PaymentsController, PaymentBackfillsController],
  providers: [PaymentsService, PaymentBackfillService],
  exports: [PaymentBackfillService],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentClassificationHistoryService],
  exports: [PaymentsService, PaymentClassificationHistoryService],
})
export class PaymentsModule {}
