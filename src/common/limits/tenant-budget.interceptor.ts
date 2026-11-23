import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Observable, throwError } from "rxjs";
import { catchError, finalize } from "rxjs/operators";
import { SessionService } from "../../auth/session.service";
import { TenantBudgetService } from "./tenant-budget.service";

@Injectable()
export class TenantBudgetInterceptor implements NestInterceptor {
  constructor(
    private readonly budgetService: TenantBudgetService,
    private readonly sessionService: SessionService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const session = await this.tryGetSession(request);
    if (!session) {
      return next.handle();
    }

    const handler = context.getHandler();
    const controller = context.getClass();
    const operationClass = this.getOperationClass(handler, controller);
    const isSecurityOperation = this.isSecurityOperation(handler, controller);

    const weight = 1;
    const acquireResult = await this.budgetService.acquire({
      tenantId: session.userId,
      operationClass,
      weight,
      isSecurityOperation,
    });

    if (!acquireResult.admitted) {
      response.setHeader("Retry-After", acquireResult.retryAfterSeconds ?? 30);
      response.setHeader("Content-Type", "application/json");
      response.status(429);
      response.send({
        statusCode: 429,
        message: "Tenant request budget exceeded",
        error: "Too Many Requests",
      });
      return throwError(() => new Error("Budget rejected"));
    }

    const lease = acquireResult.lease!;

    return next.handle().pipe(
      finalize(async () => {
        await lease.release();
      }),
      catchError((error) => {
        return throwError(() => error);
      }),
    );
  }

  private async tryGetSession(
    request: Request,
  ): Promise<{ userId: string; sessionId: string } | null> {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return null;
    }

    const token = header.slice("Bearer ".length);
    try {
      return await this.sessionService.tryIdentify(token);
    } catch (e) {
      return null;
    }
  }

  private getOperationClass(handler: any, controller: any): string {
    const fromHandler = Reflect.getMetadata("budgetOperationClass", handler);
    if (fromHandler) return fromHandler;

    const fromController = Reflect.getMetadata("budgetOperationClass", controller);
    if (fromController) return fromController;

    return "other";
  }

  private isSecurityOperation(handler: any, controller: any): boolean {
    const fromHandler = Reflect.getMetadata("securityOperation", handler);
    if (fromHandler !== undefined) return fromHandler;

    return Reflect.getMetadata("securityOperation", controller) ?? false;
  }
}
