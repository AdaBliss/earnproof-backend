import {
  OperationAbortedError,
  boundedDeadlineMs,
  createDeadline,
} from "./deadline";

describe("boundedDeadlineMs", () => {
  const bounds = { minMs: 1_000, maxMs: 300_000 };

  it("returns an in-range value unchanged", () => {
    expect(boundedDeadlineMs(5_000, 60_000, bounds)).toBe(5_000);
  });

  it("clamps below the floor and above the ceiling", () => {
    expect(boundedDeadlineMs(5, 60_000, bounds)).toBe(1_000);
    expect(boundedDeadlineMs(9_000_000_000, 60_000, bounds)).toBe(300_000);
  });

  it("accepts the exact boundaries", () => {
    expect(boundedDeadlineMs(1_000, 60_000, bounds)).toBe(1_000);
    expect(boundedDeadlineMs(300_000, 60_000, bounds)).toBe(300_000);
  });

  it.each([undefined, null, NaN, Infinity, -5, 0, "abc"])(
    "falls back to the default for unusable value %p",
    (value) => {
      expect(boundedDeadlineMs(value, 60_000, bounds)).toBe(60_000);
    },
  );

  it("never returns a value outside the bounds even when the default is out of range", () => {
    expect(boundedDeadlineMs(undefined, 10, bounds)).toBe(1_000);
  });

  it("accepts numeric strings from the environment", () => {
    expect(boundedDeadlineMs("2500", 60_000, bounds)).toBe(2_500);
  });
});

describe("createDeadline", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("aborts when the deadline elapses and reports a deadline", () => {
    const deadline = createDeadline(1_000);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.abortedError("op")).toBeUndefined();

    jest.advanceTimersByTime(999);
    expect(deadline.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut).toBe(true);
    const error = deadline.abortedError("op");
    expect(error).toBeInstanceOf(OperationAbortedError);
    expect(error?.kind).toBe("deadline");
    expect(error?.message).toBe("op exceeded its 1000ms deadline");
  });

  it("aborts when a parent aborts and reports cancellation, not a deadline", () => {
    const parent = new AbortController();
    const deadline = createDeadline(60_000, [parent.signal]);

    parent.abort();

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut).toBe(false);
    expect(deadline.abortedError("op")?.kind).toBe("cancelled");
    expect(deadline.abortedError("op")?.message).toBe("op was cancelled");
    deadline.dispose();
  });

  it("is already aborted when a parent is already aborted", () => {
    const parent = new AbortController();
    parent.abort();
    const deadline = createDeadline(60_000, [parent.signal]);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });

  it("ignores undefined parents", () => {
    const deadline = createDeadline(60_000, [undefined, undefined]);
    expect(deadline.signal.aborted).toBe(false);
    deadline.dispose();
  });

  it("dispose clears the timer so a settled operation is never aborted later", () => {
    const deadline = createDeadline(1_000);
    deadline.dispose();
    jest.advanceTimersByTime(5_000);
    expect(deadline.signal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});
