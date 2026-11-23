import { Controller, Get, INestApplication, Post } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import * as http from "http";
import { AddressInfo } from "net";
import { GlobalExceptionFilter } from "../filters/global-exception.filter";
import { RequestAbortInterceptor } from "./request-abort.interceptor";
import {
  guardTransactionsAgainstAbort,
  throwIfRequestAborted,
} from "../request-context/request-abort";

/**
 * End-to-end over a real HTTP connection: the client disconnects while a list
 * query or a mutation is in progress, and the server must stop issuing database
 * work and settle the transaction cleanly.
 *
 * The database is a fake that models Prisma's commit/rollback contract; a real
 * Postgres is not required to exercise the cancellation path.
 */

const db = {
  listQueries: 0,
  followOnStatements: 0,
  committed: 0,
  rolledBack: 0,
  firstQueryStarted: undefined as (() => void) | undefined,
  releaseFirstQuery: undefined as (() => void) | undefined,
};

function resetDb() {
  Object.assign(db, {
    listQueries: 0,
    followOnStatements: 0,
    committed: 0,
    rolledBack: 0,
    firstQueryStarted: undefined,
    releaseFirstQuery: undefined,
  });
}

/** Resolves when the handler's first statement is in flight, until released. */
function inFlightStatement(): Promise<void> {
  return new Promise<void>((resolve) => {
    db.releaseFirstQuery = resolve;
    db.firstQueryStarted?.();
  });
}

const fakePrisma = {
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      payment: {
        update: async () => {
          db.followOnStatements += 1;
        },
      },
    };
    try {
      const result = await callback(tx);
      db.committed += 1;
      return result;
    } catch (error) {
      db.rolledBack += 1;
      throw error;
    }
  },
};
guardTransactionsAgainstAbort(fakePrisma);

@Controller("probe")
class ProbeController {
  @Get("list")
  async list() {
    throwIfRequestAborted();
    db.listQueries += 1;
    await inFlightStatement(); // first page query
    throwIfRequestAborted(); // guard before the follow-on count query
    db.followOnStatements += 1;
    return { data: [] };
  }

  @Post("mutate")
  async mutate() {
    return fakePrisma.$transaction(async (tx) => {
      const t = tx as { payment: { update: () => Promise<void> } };
      await t.payment.update(); // statement 1 runs
      await inFlightStatement(); // client disconnects here
      await t.payment.update(); // statement 2 must never be issued
      return { ok: true };
    });
  }
}

describe("request abort over HTTP", () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: RequestAbortInterceptor },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(resetDb);

  /** Sends a request and destroys the socket once the first statement runs. */
  function requestThenDisconnect(method: "GET" | "POST", path: string) {
    return new Promise<void>((resolve) => {
      db.firstQueryStarted = () => {
        req.destroy();
        // Let the server observe the close before the statement finishes.
        setTimeout(() => {
          db.releaseFirstQuery?.();
          setTimeout(resolve, 50);
        }, 50);
      };
      const req = http.request({ port, method, path, host: "127.0.0.1" });
      req.on("error", () => undefined); // expected: we hang up
      req.end();
    });
  }

  it("stops follow-on database work when a list request disconnects", async () => {
    await requestThenDisconnect("GET", "/probe/list");

    expect(db.listQueries).toBe(1);
    expect(db.followOnStatements).toBe(0);
  });

  it("rolls the transaction back when a mutation request disconnects", async () => {
    await requestThenDisconnect("POST", "/probe/mutate");

    // Statement 1 ran; statement 2 was refused; nothing was committed.
    expect(db.followOnStatements).toBe(1);
    expect(db.committed).toBe(0);
    expect(db.rolledBack).toBe(1);
  });

  it("completes normally and commits when the client stays connected", async () => {
    db.firstQueryStarted = () => setTimeout(() => db.releaseFirstQuery?.(), 10);

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { port, method: "POST", path: "/probe/mutate", host: "127.0.0.1" },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(`${res.statusCode}:${data}`));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(body).toBe('201:{"ok":true}');
    expect(db.committed).toBe(1);
    expect(db.rolledBack).toBe(0);
  });
});
