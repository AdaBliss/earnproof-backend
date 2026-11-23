import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as request from "supertest";
import { configureApp } from "../../src/bootstrap";
import {
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  createCorsOptions,
  exactCorsOrigin,
} from "../../src/common/http/cors-origin-policy";

@Controller("cors-probe")
class CorsProbeController {
  @Get()
  probe() {
    return { value: "response body remains protected by browser CORS" };
  }
}

@Module({ controllers: [CorsProbeController] })
class CorsProbeModule {}

describe("exact CORS origin policy", () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  async function createApp(origin = "https://app.example.com") {
    const testApp = await NestFactory.create(CorsProbeModule, {
      logger: false,
    });
    configureApp(testApp, { corsOrigin: origin });
    await testApp.init();
    app = testApp;
    return testApp;
  }

  it("allows credentialed preflight only for the configured origin", async () => {
    const testApp = await createApp();
    const response = await request(testApp.getHttpServer())
      .options("/api/v1/cors-probe")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "POST")
      .set(
        "Access-Control-Request-Headers",
        "authorization,content-type,idempotency-key,if-none-match,x-organization-id,x-request-id",
      )
      .expect(204);

    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toBe(
      CORS_ALLOWED_METHODS.join(","),
    );
    expect(response.headers["access-control-allow-headers"]).toBe(
      CORS_ALLOWED_HEADERS.join(","),
    );
  });

  it("omits CORS access when an unlisted origin requests a resource", async () => {
    const testApp = await createApp();
    const response = await request(testApp.getHttpServer())
      .get("/api/v1/cors-probe")
      .set("Origin", "https://attacker.example")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(
      response.headers["access-control-allow-credentials"],
    ).toBeUndefined();
  });

  it("does not grant CORS access to opaque null origins", async () => {
    const testApp = await createApp();
    const response = await request(testApp.getHttpServer())
      .get("/api/v1/cors-probe")
      .set("Origin", "null")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(
      response.headers["access-control-allow-credentials"],
    ).toBeUndefined();
  });

  it("does not advertise unlisted preflight methods or headers", async () => {
    const testApp = await createApp();
    const response = await request(testApp.getHttpServer())
      .options("/api/v1/cors-probe")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "TRACE")
      .set("Access-Control-Request-Headers", "x-private-token")
      .expect(204);

    expect(response.headers["access-control-allow-methods"]).not.toContain(
      "TRACE",
    );
    expect(response.headers["access-control-allow-headers"]).not.toContain(
      "x-private-token",
    );
  });

  it.each([
    ["wildcard", "*"],
    ["opaque", "null"],
    ["path", "https://app.example.com/dashboard"],
    ["query", "https://app.example.com?next=/dashboard"],
    ["fragment", "https://app.example.com#dashboard"],
    ["credentials", "https://user:pass@app.example.com"],
    ["non-web scheme", "file://app.example.com"],
  ])("rejects a configured %s origin", (_label, origin) => {
    expect(exactCorsOrigin(origin)).toBeUndefined();
    expect(() => createCorsOptions(origin)).toThrow(/exact HTTP\(S\) origin/);
  });
});
