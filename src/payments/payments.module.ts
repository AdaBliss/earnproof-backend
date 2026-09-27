import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { StellarModule } from "../stellar/stellar.module";
import { PaymentBackfillService } from "./payment-backfill.service";
import { PaymentBackfillsController } from "./payment-backfills.controller";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";

@Module({
  imports: [AuthModule, StellarModule],
  controllers: [PaymentsController, PaymentBackfillsController],
  providers: [PaymentsService, PaymentBackfillService],
  exports: [PaymentBackfillService],
})
export class PaymentsModule {}
