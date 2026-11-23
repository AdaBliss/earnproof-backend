import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Response } from "express";
import { Observable } from "rxjs";
import {
  RequestAbortedError,
  runWithRequestSignal,
} from "../request-context/request-abort";

/**
 * Propagates client disconnects into the request's async context.
 *
 * The signal is aborted when the connection closes before the response
 * finished. It is bound with AsyncLocalStorage for the handler's duration, so
 * the database layer stops issuing work for an abandoned request, and the
 * handler's observable is terminated with {@link RequestAbortedError}.
 */
@Injectable()
export class RequestAbortInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const res = context.switchToHttp().getResponse<Response>();
    const controller = new AbortController();

    return new Observable((subscriber) => {
      const onClose = () => {
        // `close` also fires after a normal response; only an early close is a
        // disconnect.
        if (!res.writableFinished && !controller.signal.aborted) {
          controller.abort();
          subscriber.error(new RequestAbortedError());
        }
      };
      res.once("close", onClose);

      // The handler must be subscribed inside the context so that every async
      // continuation it starts inherits the signal.
      const subscription = runWithRequestSignal(controller.signal, () =>
        next.handle().subscribe(subscriber),
      );

      return () => {
        res.removeListener("close", onClose);
        subscription.unsubscribe();
      };
    });
  }
}
