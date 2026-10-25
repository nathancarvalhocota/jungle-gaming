import { describe, expect, test } from "bun:test";
import type { ArgumentsHost } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { WalletHttpErrorFilter } from "../../src/modules/wagering/presentation/wallet-http-error.filter.ts";

describe("Wallet HTTP error mapping", () => {
  test("maps known database connection failures to 503 through wrapped causes", () => {
    const response = invokeFilter(
      new Error("request failed", {
        cause: Object.assign(new Error("connection refused"), {
          code: "ECONNREFUSED",
        }),
      }),
    );
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ code: "DATABASE_UNAVAILABLE" });
  });

  test("maps recognized PostgreSQL connection SQLSTATE to 503", () => {
    const response = invokeFilter(
      Object.assign(new Error("connection lost"), { code: "08006" }),
    );
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ code: "DATABASE_UNAVAILABLE" });
  });

  test("keeps unrelated SQL failures and unknown errors generic 500", () => {
    const sqlFailure = invokeFilter(
      Object.assign(new Error("duplicate"), { code: "23505" }),
    );
    expect(sqlFailure.statusCode).toBe(500);
    expect(sqlFailure.body).toEqual({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    });
    const lookalikeCode = invokeFilter(
      Object.assign(new Error("not a network failure"), { code: "0806x" }),
    );
    expect(lookalikeCode.statusCode).toBe(500);
  });
});

function invokeFilter(error: unknown): { statusCode: number; body: unknown } {
  const result: { statusCode: number; body: unknown } = {
    statusCode: 0,
    body: undefined,
  };
  const response = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ url: "/wallets/test" }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  new WalletHttpErrorFilter(new HttpAdapterHost()).catch(error, host);
  return result;
}
