import { Controller, Get, INestApplication, Module, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request } from "express";
import * as request from "supertest";
import { configureApp } from "../../bootstrap";

@Controller("client-ip")
class ClientIpController {
  @Get()
  getClientIp(@Req() req: Request) {
    return { ip: req.ip };
  }
}

@Module({ controllers: [ClientIpController] })
class ClientIpTestModule {}

describe("client IP proxy policy HTTP integration", () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  async function createApp(policy: {
    proxyHops: number;
    trustedProxyCidrs: readonly string[];
  }): Promise<INestApplication> {
    const testApp = await NestFactory.create(ClientIpTestModule, {
      logger: false,
    });
    configureApp(testApp, { clientIpPolicy: policy });
    await testApp.init();
    app = testApp;
    return testApp;
  }

  it("uses the socket peer and ignores forged forwarding headers by default", async () => {
    const testApp = await createApp({
      proxyHops: 0,
      trustedProxyCidrs: [],
    });

    await request(testApp.getHttpServer())
      .get("/api/v1/client-ip")
      .set("X-Forwarded-For", "203.0.113.99")
      .expect(200)
      .expect(({ body }) => {
        expect(body.ip).toBe("::ffff:127.0.0.1");
      });
  });

  it("resolves the client IP only through a valid approved proxy chain", async () => {
    const testApp = await createApp({
      proxyHops: 1,
      trustedProxyCidrs: ["127.0.0.1/32"],
    });

    await request(testApp.getHttpServer())
      .get("/api/v1/client-ip")
      .set("X-Forwarded-For", "203.0.113.8")
      .expect(200)
      .expect(({ body }) => {
        expect(body.ip).toBe("203.0.113.8");
      });
  });

  it("rejects malformed forwarding chains without entering the controller", async () => {
    const testApp = await createApp({
      proxyHops: 1,
      trustedProxyCidrs: ["127.0.0.1/32"],
    });

    await request(testApp.getHttpServer())
      .get("/api/v1/client-ip")
      .set("X-Forwarded-For", "not-an-ip")
      .expect(400)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          statusCode: 400,
          code: "INVALID_INPUT",
          message: "The trusted proxy forwarding chain is invalid.",
        });
      });
  });
});
