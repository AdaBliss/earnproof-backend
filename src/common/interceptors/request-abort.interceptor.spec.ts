import { ExecutionContext } from "@nestjs/common";
import { EventEmitter } from "events";
import { Observable, firstValueFrom } from "rxjs";
import { RequestAbortInterceptor } from "./request-abort.interceptor";
import {
  RequestAbortedError,
  currentRequestSignal,
  throwIfRequestAborted,
} from "../request-context/request-abort";

type FakeResponse = EventEmitter & { writableFinished: boolean };

function makeResponse(): FakeResponse {
  return Object.assign(new EventEmitter(), { writableFinished: false });
}

function makeContext(res: FakeResponse) {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function emitting<T>(value: T, onStart?: () => void) {
  return new Observable<T>((subscriber) => {
    onStart?.();
    subscriber.next(value);
    subscriber.complete();
  });
}

describe("RequestAbortInterceptor", () => {
  const interceptor = new RequestAbortInterceptor();

  it("binds a live signal for the handler and passes the result through", async () => {
    const res = makeResponse();
    let seen: AbortSignal | undefined;

    const result = await firstValueFrom(
      interceptor.intercept(makeContext(res), {
        handle: () =>
          emitting("ok", () => {
            seen = currentRequestSignal();
          }),
      }),
    );

    expect(result).toBe("ok");
    expect(seen?.aborted).toBe(false);
  });

  it("does not treat the close that follows a finished response as an abort", async () => {
    const res = makeResponse();
    let seen: AbortSignal | undefined;

    await firstValueFrom(
      interceptor.intercept(makeContext(res), {
        handle: () =>
          emitting(1, () => {
            seen = currentRequestSignal();
          }),
      }),
    );
    res.writableFinished = true;
    res.emit("close");

    expect(seen?.aborted).toBe(false);
  });

  it("aborts the signal and errors the request on an early disconnect", async () => {
    const res = makeResponse();
    let seen: AbortSignal | undefined;
    const observable = interceptor.intercept(makeContext(res), {
      handle: () =>
        new Observable(() => {
          seen = currentRequestSignal(); // never completes: a slow handler
        }),
    });

    const outcome = firstValueFrom(observable);
    res.emit("close");

    await expect(outcome).rejects.toBeInstanceOf(RequestAbortedError);
    expect(seen?.aborted).toBe(true);
  });

  it("stops follow-on work in a handler that is mid-flight when the client disconnects", async () => {
    const res = makeResponse();
    const followOnQuery = jest.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let handlerOutcome: unknown;

    const observable = interceptor.intercept(makeContext(res), {
      handle: () =>
        new Observable((subscriber) => {
          void (async () => {
            await gate; // the first DB round-trip is still running
            try {
              throwIfRequestAborted(); // the guard in front of the next query
              followOnQuery();
            } catch (error) {
              handlerOutcome = error;
            }
            subscriber.complete();
          })();
        }),
    });

    const outcome = firstValueFrom(observable).catch((error: unknown) => error);
    res.emit("close");
    release();
    await outcome;
    await new Promise((resolve) => setImmediate(resolve));

    expect(followOnQuery).not.toHaveBeenCalled();
    expect(handlerOutcome).toBeInstanceOf(RequestAbortedError);
  });

  it("removes its close listener when the subscription ends", async () => {
    const res = makeResponse();

    await firstValueFrom(
      interceptor.intercept(makeContext(res), { handle: () => emitting(1) }),
    );

    expect(res.listenerCount("close")).toBe(0);
  });

  it("ignores non-http contexts", async () => {
    const ctx = { getType: () => "rpc" } as unknown as ExecutionContext;

    await expect(
      firstValueFrom(
        interceptor.intercept(ctx, { handle: () => emitting("rpc") }),
      ),
    ).resolves.toBe("rpc");
  });
});
