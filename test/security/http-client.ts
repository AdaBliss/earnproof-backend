import { request as httpRequest } from "http";
import { AddressInfo } from "net";
import { INestApplication } from "@nestjs/common";

/**
 * A minimal HTTP client for the boundary tests.
 *
 * Deliberately raw rather than supertest: these tests are about bytes on a
 * socket — an oversized body, a body the server refuses mid-stream — and a
 * client that serialises objects for you hides exactly the thing under test.
 * It also keeps the suite free of a dependency whose types are not installed.
 */

export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  /** Parsed body, or `undefined` when the response is not JSON. */
  readonly json: Record<string, unknown> | undefined;
}

/** Starts the application on an ephemeral port and returns its base URL. */
export async function listen(app: INestApplication): Promise<string> {
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer() as { address(): AddressInfo | string | null };
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("The test server did not bind to a TCP port.");
  }

  return `http://127.0.0.1:${address.port}`;
}

/**
 * POSTs a raw body.
 *
 * The body is passed as a string, never an object, so a test can send something
 * that is not valid JSON or is larger than the server will accept — both of
 * which are cases here.
 */
export function postRaw(
  baseUrl: string,
  path: string,
  body: string,
  contentType = "application/json",
): Promise<HttpResponse> {
  return postBytes(baseUrl, path, Buffer.from(body), {
    "content-type": contentType,
  });
}

/** POSTs bytes with explicit headers for compressed transport fixtures. */
export function postBytes(
  baseUrl: string,
  path: string,
  body: Buffer,
  headers: Record<string, string | string[]>,
): Promise<HttpResponse> {
  const url = new URL(path, baseUrl);

  return new Promise((resolve, reject) => {
    let responded = false;

    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          ...headers,
          "content-length": body.length,
        },
      },
      (res) => {
        responded = true;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> | undefined;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = undefined;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );

    // The server can answer 413 and destroy the socket before the whole body
    // has been written, which surfaces as ECONNRESET or EPIPE on the write
    // side. That is the server behaving correctly — refusing early rather than
    // reading megabytes it has already decided to reject — so the write error
    // is ignored and the response, if one arrived, is what the test sees.
    req.on("error", (error: NodeJS.ErrnoException) => {
      const writeSideReset =
        error.code === "ECONNRESET" || error.code === "EPIPE";

      if (writeSideReset && responded) return;

      if (writeSideReset) {
        // The connection went away without an answer. Reported as status 0
        // rather than as a rejection, so a test asserting on a status fails
        // with what happened instead of hanging or throwing somewhere else.
        resolve({ status: 0, headers: {}, text: "", json: undefined });
        return;
      }

      reject(error);
    });

    req.end(body);
  });
}

/** POSTs a JSON value. */
export function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<HttpResponse> {
  return postRaw(baseUrl, path, JSON.stringify(body));
}
