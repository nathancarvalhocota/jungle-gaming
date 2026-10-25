import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  Controller,
  type INestApplication,
  Module,
  Post,
  Req,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module.ts";
import { NoAuthGuard } from "../../src/platform/identity/no-auth.guard.ts";

@Controller("auth-probe")
class AuthProbeController {
  @Post()
  inspect(@Req() request: Record<string, unknown>) {
    return {
      hasUser: "user" in request,
      hasAuth: "auth" in request,
      hasProviderIdentity: "providerIdentity" in request,
    };
  }
}

@Module({ imports: [AppModule], controllers: [AuthProbeController] })
class AuthProbeModule {}

describe("HTTP authentication extension", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(AuthProbeModule, {
      abortOnError: false,
      logger: false,
    });
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  test("allows HTTP without Authorization and does not create an identity", async () => {
    const response = await fetch(`${baseUrl}/auth-probe`, { method: "POST" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      hasUser: false,
      hasAuth: false,
      hasProviderIdentity: false,
    });
  });

  test("does not promote credentials or supplied providerId to authenticated identity", async () => {
    const response = await fetch(`${baseUrl}/auth-probe`, {
      method: "POST",
      headers: {
        Authorization: "Bearer unverified",
        providerId: "unverified",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: "unverified",
        user: { id: "unverified" },
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      hasUser: false,
      hasAuth: false,
      hasProviderIdentity: false,
    });
  });

  test("replacing the authentication provider blocks other routes while health stays public", async () => {
    const guard = spyOn(app.get(NoAuthGuard), "canActivate").mockReturnValue(
      false,
    );
    try {
      const denied = await fetch(`${baseUrl}/auth-probe`, { method: "POST" });
      expect(denied.status).toBe(403);
      expect(guard).toHaveBeenCalledTimes(1);
      const health = await fetch(`${baseUrl}/health/live`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      expect(guard).toHaveBeenCalledTimes(1);
    } finally {
      guard.mockRestore();
    }
  });
});
