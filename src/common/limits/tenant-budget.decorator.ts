import { SetMetadata } from "@nestjs/common";

export const SecurityOperation = () => SetMetadata("securityOperation", true);

export const BudgetOperationClass = (operationClass: string) =>
  SetMetadata("budgetOperationClass", operationClass);
