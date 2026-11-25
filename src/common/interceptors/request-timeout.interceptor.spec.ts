import { ExecutionContext, RequestTimeoutException } from "@nestjs/common";
import { Observable, lastValueFrom, of } from "rxjs";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  RequestTimeoutInterceptor,
} from "./request-timeout.interceptor";
import {
  currentRequestSignal,
  runWithRequestSignal,
} from "../request-context/request-abort";

const httpContext = { getType: () => "http" } as unknown as ExecutionContext;

function interceptorWith(ms?: number) {
  return new RequestTimeoutInterceptor(
    ms === undefined
      ? undefined
      : ({ get: () => ms } as never),
  );
}

describe("RequestTimeoutInterceptor", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("passes a fast handler result through and clears its timer", async () => {
    const result = await lastValueFrom(
      interceptorWith().intercept(httpContext, { handle: () => of("ok") }),
    );
    expect(result).toBe("ok");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("rejects with 408 at the default deadline and aborts the handler signal", async () => {
    let handlerSignal: AbortSignal | undefined;
    const slow = new Observable<string>(() => {
      handlerSignal = currentRequestSignal();
    });

    const pending = lastValueFrom(
      interceptorWith().intercept(httpContext, { handle: () => slow }),
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutException);

    await jest.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(handlerSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await assertion;
    expect(handlerSignal?.aborted).toBe(true);
  });

  it("makes work started by the handler observe the abort", async () => {
    let observed: AbortSignal | undefined;
    const handler = new Observable<string>(() => {
      // Models a downstream call (database guard, contract call) reading the
      // ambient request signal after an async hop.
      void Promise.resolve().then(() => {
        observed = currentRequestSignal();
      });
    });

    const pending = lastValueFrom(
      interceptorWith(1_000).intercept(httpContext, { handle: () => handler }),
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutException);
    await jest.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(observed?.aborted).toBe(true);
  });

  it("honours a configured deadline and clamps it into 100ms..120s", async () => {
    const never = new Observable<string>(() => undefined);

    // 1ms is clamped up to 100ms.
    const clamped = lastValueFrom(
      interceptorWith(1).intercept(httpContext, { handle: () => never }),
    );
    const clampedAssertion = expect(clamped).rejects.toBeInstanceOf(RequestTimeoutException);
    await jest.advanceTimersByTimeAsync(99);
    let settled = false;
    void clamped.catch(() => (settled = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await clampedAssertion;

    // 1e9 is clamped down to 120s.
    const high = lastValueFrom(
      interceptorWith(1e9).intercept(httpContext, { handle: () => never }),
    );
    const highAssertion = expect(high).rejects.toBeInstanceOf(RequestTimeoutException);
    await jest.advanceTimersByTimeAsync(120_000);
    await highAssertion;
  });

  it("does not convert a client disconnect into a timeout", async () => {
    const parent = new AbortController();
    const never = new Observable<string>(() => undefined);

    const pending = runWithRequestSignal(parent.signal, () =>
      lastValueFrom(interceptorWith().intercept(httpContext, { handle: () => never })),
    );
    let outcome: unknown = "pending";
    void pending.then(
      (v) => (outcome = v),
      (e) => (outcome = e),
    );

    parent.abort();
    await jest.advanceTimersByTimeAsync(0);

    // The abort interceptor owns disconnect handling; this one stays silent
    // and the handler signal still reports aborted.
    expect(outcome).toBe("pending");
  });

  it("leaves non-HTTP contexts untouched", async () => {
    const rpc = { getType: () => "rpc" } as unknown as ExecutionContext;
    await expect(
      lastValueFrom(interceptorWith().intercept(rpc, { handle: () => of("x") })),
    ).resolves.toBe("x");
  });
});
