import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
  RequestTimeoutException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Observable } from "rxjs";
import {
  currentRequestSignal,
  runWithRequestSignal,
} from "../request-context/request-abort";
import { boundedDeadlineMs, createDeadline } from "../resilience/deadline";

/** A request deadline below the floor cannot serve anything; above the ceiling it is not a deadline. */
export const REQUEST_TIMEOUT_BOUNDS = { minMs: 100, maxMs: 120_000 } as const;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Bounds a handler's wall-clock time AND cancels the work when it elapses.
 *
 * Rejecting the response alone (the previous behaviour) left the handler running:
 * Prisma statements, contract CLI children and RPC calls carried on after the
 * client had been told "timed out". The deadline here is an `AbortSignal` bound
 * into the request's async context, so the database abort guard and the contract
 * call layer observe it and stop issuing work. It also inherits any signal
 * already bound by the client-disconnect interceptor.
 */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  private readonly timeoutMs: number;

  constructor(@Optional() config?: ConfigService) {
    this.timeoutMs = boundedDeadlineMs(
      config?.get<number>("http.verificationTimeoutMs"),
      DEFAULT_REQUEST_TIMEOUT_MS,
      REQUEST_TIMEOUT_BOUNDS,
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    return new Observable((subscriber) => {
      const deadline = createDeadline(this.timeoutMs, [currentRequestSignal()]);

      const onAbort = () => {
        // Only the deadline itself is a timeout. A parent cancellation (client
        // disconnect) is already surfaced by the abort interceptor.
        if (deadline.timedOut) {
          subscriber.error(new RequestTimeoutException("Verification timed out"));
        }
      };
      deadline.signal.addEventListener("abort", onAbort, { once: true });

      // Subscribed inside the context so every async continuation inherits the
      // deadline signal.
      const subscription = runWithRequestSignal(deadline.signal, () =>
        next.handle().subscribe(subscriber),
      );

      return () => {
        deadline.signal.removeEventListener("abort", onAbort);
        deadline.dispose();
        subscription.unsubscribe();
      };
    });
  }
}
