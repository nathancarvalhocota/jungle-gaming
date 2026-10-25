import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "../../src/main.ts";
import {
  InvalidWalletInputError,
  WalletAlreadyExistsError,
} from "../../src/modules/wagering/application/wallet.errors.ts";
import { WalletUseCases } from "../../src/modules/wagering/application/wallet.use-cases.ts";
import { Money } from "../../src/modules/wagering/domain/money.ts";
import { Wallet } from "../../src/modules/wagering/domain/wallet/wallet.ts";
import { WalletSchema } from "../../src/modules/wagering/infrastructure/persistence/wallet.schema.ts";
import { MikroOrmWalletUnitOfWork } from "../../src/modules/wagering/infrastructure/persistence/wallet.unit-of-work.ts";
import { createOrmOptions } from "../../src/platform/persistence/orm.config.ts";

describe("Wallet zero persistida", () => {
  const databaseName = `wallet_validation_${randomUUID().replaceAll("-", "")}`;
  let previousUrl: string | undefined;
  let admin: MikroORM | undefined;
  let orm: MikroORM;
  let observer: MikroORM;
  let app: INestApplication | undefined;
  let databaseCreated = false;
  let testDatabaseUrl: string;

  beforeAll(async () => {
    previousUrl = process.env.DATABASE_URL;
    if (!previousUrl)
      throw new Error("DATABASE_URL is required for wallet integration tests");
    admin = await MikroORM.init(createOrmOptions());
    await admin.em.getConnection().execute(`create database "${databaseName}"`);
    databaseCreated = true;
    const testUrl = new URL(previousUrl);
    testUrl.pathname = `/${databaseName}`;
    testDatabaseUrl = testUrl.toString();
    process.env.DATABASE_URL = testDatabaseUrl;

    const options = createOrmOptions();
    orm = await MikroORM.init(options);
    observer = await MikroORM.init(options);
    await assertDisposableTarget(observer);
    await runMigrationScript("up");
  });

  afterAll(async () => {
    let cleanupVerified = false;
    try {
      try {
        const connection = observer ?? orm;
        if (connection) {
          await assertDisposableTarget(connection);
          cleanupVerified = true;
        }
      } finally {
        await app?.close();
        await observer?.close(true);
        await orm?.close(true);
      }
      if (admin && databaseCreated && cleanupVerified) {
        console.info(`Wallet test cleanup: database=${databaseName}`);
        await admin.em
          .getConnection()
          .execute(`drop database "${databaseName}" with (force)`);
      }
    } finally {
      await admin?.close(true);
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
  });

  test("migration de wallet aplica, reverte e reaplica no banco descartável", async () => {
    expect(await orm.migrator.getExecuted()).toHaveLength(1);
    await runMigrationScript("down");
    const removed = await observer.em
      .getConnection()
      .execute<{ table_name: string | null }[]>(
        "select to_regclass('wallets') as table_name",
      );
    expect(removed[0]?.table_name).toBeNull();
    await expect(
      runMigrationScript("up", "unexpected_database"),
    ).rejects.toThrow("does not match the expected target");
    expect(
      await observer.em
        .getConnection()
        .execute("select to_regclass('wallets') as table_name"),
    ).toEqual([{ table_name: null }]);
    await runMigrationScript("up");
    expect(await orm.migrator.getExecuted()).toHaveLength(1);
  });

  test("cria e reidrata saldo zero preservando centavos, IDs, versão e datas", async () => {
    const useCases = new WalletUseCases(new MikroOrmWalletUnitOfWork(orm.em));
    const created = await useCases.create({
      playerId: "player-roundtrip",
      initialBalance: { amount: "0.00", currency: "BRL" },
    });
    const restored = await new MikroOrmWalletUnitOfWork(observer.em).execute(
      async (repository) => repository.findById(created.id),
    );
    expect(restored).toBeDefined();
    expect(restored?.id).toBe(created.id);
    expect(restored?.playerId).toBe("player-roundtrip");
    expect(restored?.balance.toJSON()).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
    expect(restored?.version).toBe(1);
    expect(restored?.createdAt.getTime()).toBe(restored?.updatedAt.getTime());
    expect(created).toEqual({
      id: created.id,
      playerId: "player-roundtrip",
      balance: { amount: "0.00", currency: "BRL" },
      version: 1,
    });
  });

  test("recusa abertura positiva sem qualquer escrita", async () => {
    const useCases = new WalletUseCases(new MikroOrmWalletUnitOfWork(orm.em));
    const before = await observer.em.fork().count(WalletSchema);
    await expect(
      useCases.create({
        playerId: "player-positive",
        initialBalance: { amount: "0.01", currency: "BRL" },
      }),
    ).rejects.toMatchObject({ name: "OpeningBalanceNotAvailableError" });
    expect(await observer.em.fork().count(WalletSchema)).toBe(before);
  });

  test("valida entradas runtime estritas sem persistir carteiras", async () => {
    const useCases = new WalletUseCases(new MikroOrmWalletUnitOfWork(orm.em));
    const before = await observer.em.fork().count(WalletSchema);
    const invalidInputs: unknown[] = [
      null,
      { playerId: "player", initialBalance: { amount: 0, currency: "BRL" } },
      { playerId: "player", initialBalance: { amount: "0.00" } },
      {
        playerId: "player",
        initialBalance: { amount: "-0.01", currency: "BRL" },
      },
      {
        playerId: "player",
        initialBalance: { amount: "1000000.01", currency: "BRL" },
      },
      {
        playerId: "player",
        initialBalance: { amount: "0.00", currency: null },
      },
      {
        playerId: "player",
        initialBalance: { amount: "0.00", currency: "BRL" },
        extra: true,
      },
    ];
    for (const input of invalidInputs) {
      await expect(useCases.create(input)).rejects.toBeInstanceOf(
        InvalidWalletInputError,
      );
    }
    expect(await observer.em.fork().count(WalletSchema)).toBe(before);
  });

  test("fixtures persistem bigint exato e reidratam IDs, versão e datas", async () => {
    const unitOfWork = new MikroOrmWalletUnitOfWork(orm.em);
    const fixtures = ["0.01", "25.37", "1000000.00"].map((amount, index) => {
      const createdAt = new Date(Date.UTC(2026, 0, index + 1, 10, 20, 30, 123));
      const updatedAt = new Date(Date.UTC(2026, 0, index + 2, 11, 21, 31, 987));
      return Wallet.rehydrate({
        id: randomUUID(),
        playerId: `wallet-roundtrip-${index}`,
        currency: "BRL",
        balance: Money.from({ amount, currency: "BRL" }),
        version: 7,
        createdAt,
        updatedAt,
      });
    });
    await unitOfWork.execute(async (repository) => {
      for (const wallet of fixtures) await repository.create(wallet);
    });
    for (const [index, original] of fixtures.entries()) {
      const restored = await new MikroOrmWalletUnitOfWork(observer.em).execute(
        (repository) => repository.findById(original.id),
      );
      expect(restored?.id).toBe(original.id);
      expect(restored?.playerId).toBe(original.playerId);
      expect(restored?.balance.toJSON()).toEqual(original.balance.toJSON());
      expect(restored?.version).toBe(7);
      expect(restored?.createdAt.getTime()).toBe(original.createdAt.getTime());
      expect(restored?.updatedAt.getTime()).toBe(original.updatedAt.getTime());
      const rows = await observer.em
        .getConnection()
        .execute<{ balance_minor_units: string }[]>(
          "select balance_minor_units::text as balance_minor_units from wallets where id = ?",
          [original.id],
        );
      expect(rows[0]?.balance_minor_units).toBe(
        ["1", "2537", "100000000"][index],
      );
    }
  });

  test("schema rejeita saldo negativo e acima do teto por SQL direto", async () => {
    const id = randomUUID();
    const insertWallet = (balanceMinorUnits: string) =>
      observer.em.getConnection().execute(
        `insert into wallets (id, player_id, currency, balance_minor_units, version, created_at, updated_at)
         values (?, ?, 'BRL', ?, 1, now(), now())`,
        [id, `sql-${balanceMinorUnits}`, balanceMinorUnits],
      );
    await expect(insertWallet("-1")).rejects.toMatchObject({
      code: "23514",
      constraint: "wallets_balance_nonnegative",
    });
    await expect(insertWallet("100000001")).rejects.toMatchObject({
      code: "23514",
      constraint: "wallets_balance_max",
    });
  });

  test("criação concorrente para o mesmo jogador e moeda produz um único vencedor", async () => {
    const create = () =>
      new WalletUseCases(new MikroOrmWalletUnitOfWork(orm.em)).create({
        playerId: "player-race",
        initialBalance: { amount: "0.00", currency: "BRL" },
      });
    const results = await Promise.allSettled([create(), create()]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(WalletAlreadyExistsError);
    }
    expect(
      await observer.em
        .fork()
        .count(WalletSchema, { playerId: "player-race", currency: "BRL" }),
    ).toBe(1);
  });

  test("outra violação única não é mascarada como conflito de Wallet", async () => {
    const id = randomUUID();
    const unitOfWork = new MikroOrmWalletUnitOfWork(orm.em);
    const makeWallet = (playerId: string) =>
      Wallet.rehydrate({
        id,
        playerId,
        currency: "BRL",
        balance: Money.zero("BRL"),
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    await unitOfWork.execute((repository) =>
      repository.create(makeWallet("pk-first")),
    );
    await expect(
      unitOfWork.execute((repository) =>
        repository.create(makeWallet("pk-second")),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "wallets_pkey" });
  });

  test("HTTP cria e consulta carteira e mapeia erros acordados", async () => {
    app = await createApplication();
    await app.listen(0, "127.0.0.1");
    const baseUrl = `${await app.getUrl()}/wallets`;
    const createResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-http",
        initialBalance: { amount: "0.00", currency: "BRL" },
      }),
    });
    expect(createResponse.status).toBe(201);
    const walletValue: unknown = await createResponse.json();
    if (!isRecord(walletValue) || typeof walletValue.id !== "string") {
      throw new Error("Wallet response did not contain an ID");
    }
    const wallet = walletValue;
    expect(wallet).toMatchObject({
      playerId: "player-http",
      balance: { amount: "0.00", currency: "BRL" },
      version: 1,
    });

    const getResponse = await fetch(`${baseUrl}/${wallet.id}`);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual(wallet);

    const invalidResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-invalid",
        initialBalance: { amount: "0.00", currency: "BRL", extra: true },
      }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      code: "INVALID_WALLET_INPUT",
    });

    const currencyResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-usd",
        initialBalance: { amount: "0.00", currency: "USD" },
      }),
    });
    expect(currencyResponse.status).toBe(400);
    expect(await currencyResponse.json()).toMatchObject({
      code: "UNSUPPORTED_CURRENCY",
    });

    const positiveResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-http-positive",
        initialBalance: { amount: "1.00", currency: "BRL" },
      }),
    });
    expect(positiveResponse.status).toBe(422);
    expect(await positiveResponse.json()).toMatchObject({
      code: "OPENING_BALANCE_NOT_AVAILABLE",
    });

    const duplicateResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: "player-http",
        initialBalance: { amount: "0.00", currency: "BRL" },
      }),
    });
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toMatchObject({
      code: "WALLET_ALREADY_EXISTS",
    });

    const missingResponse = await fetch(`${baseUrl}/${randomUUID()}`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      code: "WALLET_NOT_FOUND",
    });

    const malformedResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toMatchObject({
      code: "INVALID_WALLET_INPUT",
    });

    const invalidIdResponse = await fetch(`${baseUrl}/not-a-uuid`);
    expect(invalidIdResponse.status).toBe(400);
    expect(await invalidIdResponse.json()).toMatchObject({
      code: "INVALID_WALLET_INPUT",
    });

    const newlineIdResponse = await fetch(
      `${baseUrl}/${encodeURIComponent(`${wallet.id}\n`)}`,
    );
    expect(newlineIdResponse.status).toBe(400);
    expect(await newlineIdResponse.json()).toMatchObject({
      code: "INVALID_WALLET_INPUT",
    });
  });
  async function assertDisposableTarget(connection: MikroORM): Promise<void> {
    const [target] = await connection.em
      .getConnection()
      .execute<{ database: string }[]>("select current_database() as database");
    if (
      !/^wallet_validation_[a-f0-9]{32}$/.test(databaseName) ||
      target?.database !== databaseName
    ) {
      throw new Error("Refusing an unexpected disposable database target");
    }
  }

  async function runMigrationScript(
    direction: "up" | "down",
    expectedDatabase = databaseName,
  ): Promise<void> {
    if (
      !/^wallet_validation_[a-f0-9]{32}$/.test(databaseName) ||
      new URL(testDatabaseUrl).pathname !== `/${databaseName}`
    ) {
      throw new Error("Refusing to migrate a non-disposable test database");
    }
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/platform/persistence/migrate.ts",
        direction,
        expectedDatabase,
      ],
      {
        env: { ...process.env, DATABASE_URL: testDatabaseUrl },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Migration ${direction} failed (${exitCode}): ${stdout}${stderr}`,
      );
    }
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
