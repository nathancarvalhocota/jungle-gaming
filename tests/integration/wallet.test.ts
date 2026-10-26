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
import type {
  WalletRepositoryPort,
  WalletUnitOfWork,
} from "../../src/modules/wagering/application/wallet-ports.ts";
import { LedgerDirection } from "../../src/modules/wagering/domain/ledger/wallet-ledger-entry.ts";
import { Money } from "../../src/modules/wagering/domain/money.ts";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/transactions/wager-transaction.ts";
import { Wallet } from "../../src/modules/wagering/domain/wallet/wallet.ts";
import {
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
} from "../../src/modules/wagering/infrastructure/persistence/opening.schema.ts";
import { WalletRepository } from "../../src/modules/wagering/infrastructure/persistence/wallet.repository.ts";
import { WalletSchema } from "../../src/modules/wagering/infrastructure/persistence/wallet.schema.ts";
import { MikroOrmWalletUnitOfWork } from "../../src/modules/wagering/infrastructure/persistence/wallet.unit-of-work.ts";
import { createOrmOptions } from "../../src/platform/persistence/orm.config.ts";

describe("Wallet persistida com abertura auditável", () => {
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
    const adminUrl = new URL(previousUrl);
    adminUrl.pathname = "/postgres";
    admin = await MikroORM.init({
      ...createOrmOptions(),
      clientUrl: adminUrl.toString(),
    });
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
    expect(await orm.migrator.getExecuted()).toHaveLength(5);
    await runMigrationScript("down");
    await runMigrationScript("down");
    await runMigrationScript("down");
    await runMigrationScript("down");
    expect(
      await observer.em
        .getConnection()
        .execute(
          "select to_regclass('wallet_ledger_entries') as ledger, to_regprocedure('reject_ledger_mutation()') as trigger_function",
        ),
    ).toEqual([{ ledger: null, trigger_function: null }]);
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
    expect(await orm.migrator.getExecuted()).toHaveLength(5);
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
    expect(
      await observer.em
        .fork()
        .count(WagerTransactionSchema, { walletId: created.id }),
    ).toBe(0);
    expect(
      await observer.em
        .fork()
        .count(WalletLedgerEntrySchema, { walletId: created.id }),
    ).toBe(0);
    expect(
      await observer.em
        .fork()
        .count(OutboxMessageSchema, { aggregateId: created.id }),
    ).toBe(0);
  });

  test("abertura positiva preserva centavos, auditoria, envelope e versão 1", async () => {
    const useCases = new WalletUseCases(new MikroOrmWalletUnitOfWork(orm.em));
    for (const amount of ["0.01", "25.37", "1000000.00"]) {
      const created = await useCases.create({
        playerId: `positive-${amount}`,
        initialBalance: { amount, currency: "BRL" },
      });
      expect(created.balance).toEqual({ amount, currency: "BRL" });
      expect(created.version).toBe(1);
      expect(await useCases.get(created.id)).toEqual(created);
      const em = observer.em.fork();
      const txRecord = await em.findOneOrFail(WagerTransactionSchema, {
        walletId: created.id,
      });
      const entryRecord = await em.findOneOrFail(WalletLedgerEntrySchema, {
        walletId: created.id,
      });
      const repository = new WalletRepository(em);
      const transaction = await repository.findTransaction(txRecord.id);
      const entry = await repository.findLedgerEntry(entryRecord.id);
      expect(transaction?.origin).toBe("INTERNAL");
      expect(transaction?.kind).toBe(WagerTransactionKind.Opening);
      expect(transaction?.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction?.balance?.toJSON()).toEqual(created.balance);
      expect(transaction?.money.toJSON()).toEqual(created.balance);
      expect(transaction?.createdAt.getTime()).toBe(
        transaction?.processedAt?.getTime(),
      );
      expect(entry?.transactionId).toBe(transaction?.id);
      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(entry?.balanceBefore.toJSON().amount).toBe("0.00");
      expect(entry?.money.toJSON()).toEqual(created.balance);
      expect(entry?.balanceAfter.toJSON()).toEqual(created.balance);
      expect(entry?.isBalanced()).toBe(true);
      const rows = await em
        .getConnection()
        .execute<{ reconstructed: string }[]>(
          "select sum(case when direction = 'CREDIT' then money_minor_units else -money_minor_units end)::text as reconstructed from wallet_ledger_entries where wallet_id = ?",
          [created.id],
        );
      expect(rows[0]?.reconstructed).toBe(txRecord.moneyMinorUnits.toString());
      expect(
        await em.count(WalletLedgerEntrySchema, { walletId: created.id }),
      ).toBe(1);
      const messages = await em.find(OutboxMessageSchema, {
        aggregateId: { $in: [created.id, txRecord.id] },
      });
      expect(messages).toHaveLength(2);
      expect(messages.map((message) => message.eventType).sort()).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
      for (const record of messages) {
        const message = await repository.findOutboxMessage(record.id);
        expect(message?.isPending()).toBe(true);
        expect(message?.attempts).toBe(0);
        expect(message?.nextAttemptAt).toBeUndefined();
        expect(message?.payload).toMatchObject({
          eventId: record.id,
          eventType: record.eventType,
          aggregateId: record.aggregateId,
          correlationId: txRecord.id,
          version: 1,
          occurredAt: record.occurredAt.toISOString(),
          data: {
            transactionId: txRecord.id,
            walletId: created.id,
            money: created.balance,
          },
        });
        expect(message?.payload).not.toHaveProperty("causationId");
        expect(JSON.parse(JSON.stringify(message?.payload))).toEqual(
          message?.payload,
        );
      }
      expect(
        messages.find((message) => message.eventType === "WalletBalanceChanged")
          ?.payload,
      ).toMatchObject({
        aggregateId: created.id,
        data: {
          walletVersion: 1,
          direction: "CREDIT",
          balanceBefore: { amount: "0.00", currency: "BRL" },
          balanceAfter: created.balance,
        },
      });
      expect(
        messages.find(
          (message) => message.eventType === "WagerTransactionProcessed",
        )?.payload,
      ).toMatchObject({
        aggregateId: txRecord.id,
        data: {
          playerId: created.playerId,
          kind: "OPENING",
          status: "PROCESSED",
          balance: created.balance,
        },
      });
    }
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

  test("falhas depois de cada gravação desfazem abertura inteira observada por conexão independente", async () => {
    for (const failAfter of [1, 2, 3, 4, 5]) {
      const before = await counts();
      let writes = 0;
      const real = new MikroOrmWalletUnitOfWork(orm.em);
      const forced = new Error(`Forced failure after write ${failAfter}`);
      const unitOfWork: WalletUnitOfWork = {
        execute: (operation) =>
          real.execute(async (repository) => {
            const afterWrite = async (write: Promise<void>) => {
              await write;
              writes += 1;
              if (writes === failAfter) {
                expect(await counts()).toEqual(before);
                throw forced;
              }
            };
            const wrapped: WalletRepositoryPort = {
              create: (wallet) => afterWrite(repository.create(wallet)),
              findById: (id) => repository.findById(id),
              createTransaction: (transaction) =>
                afterWrite(repository.createTransaction(transaction)),
              createLedgerEntry: (entry) =>
                afterWrite(repository.createLedgerEntry(entry)),
              enqueue: (message) => afterWrite(repository.enqueue(message)),
            };
            return operation(wrapped);
          }),
      };
      await expect(
        new WalletUseCases(unitOfWork).create({
          playerId: `rollback-${failAfter}`,
          initialBalance: { amount: "12.34", currency: "BRL" },
        }),
      ).rejects.toBe(forced);
      expect(writes).toBe(failAfter);
      expect(await counts()).toEqual(before);
    }
  });

  test("abertura positiva concorrente produz somente uma auditoria completa", async () => {
    const useCases = new WalletUseCases(new MikroOrmWalletUnitOfWork(orm.em));
    const create = () =>
      useCases.create({
        playerId: "positive-race",
        initialBalance: { amount: "10.05", currency: "BRL" },
      });
    const results = await Promise.allSettled([create(), create(), create()]);
    const success = results.filter((result) => result.status === "fulfilled");
    expect(success).toHaveLength(1);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(WalletAlreadyExistsError);
    const wallet = await observer.em
      .fork()
      .findOneOrFail(WalletSchema, { playerId: "positive-race" });
    const tx = await observer.em
      .fork()
      .findOneOrFail(WagerTransactionSchema, { walletId: wallet.id });
    expect(
      await observer.em
        .fork()
        .count(WagerTransactionSchema, { walletId: wallet.id }),
    ).toBe(1);
    expect(
      await observer.em
        .fork()
        .count(WalletLedgerEntrySchema, { walletId: wallet.id }),
    ).toBe(1);
    expect(
      await observer.em.fork().count(OutboxMessageSchema, {
        aggregateId: { $in: [wallet.id, tx.id] },
      }),
    ).toBe(2);
    expect(wallet.version).toBe(1);
    expect(wallet.balanceMinorUnits).toBe(1005n);
  });

  test("SQL direto protege vínculos, unicidade, limites e imutabilidade do ledger", async () => {
    const created = await new WalletUseCases(
      new MikroOrmWalletUnitOfWork(orm.em),
    ).create({
      playerId: "sql-protections",
      initialBalance: { amount: "5.00", currency: "BRL" },
    });
    const em = observer.em.fork();
    const tx = await em.findOneOrFail(WagerTransactionSchema, {
      walletId: created.id,
    });
    const entry = await em.findOneOrFail(WalletLedgerEntrySchema, {
      walletId: created.id,
    });
    const sql = em.getConnection();
    const insertLedger = (
      transactionId: string,
      walletId = created.id,
      currency = "BRL",
      money = "500",
      before = "0",
      after = "500",
      direction = "CREDIT",
    ) =>
      sql.execute(
        "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, currency, money_minor_units, balance_before_minor_units, balance_after_minor_units, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, now())",
        [
          randomUUID(),
          walletId,
          transactionId,
          direction,
          currency,
          money,
          before,
          after,
        ],
      );
    await expect(insertLedger(tx.id)).rejects.toMatchObject({
      code: "23505",
      constraint: "ledger_transaction_wallet_unique",
    });
    const freshTransaction = async () => {
      const id = randomUUID();
      await sql.execute(
        "insert into wager_transactions select ?, wallet_id, player_id, origin, kind, status, currency, money_minor_units, balance_minor_units, created_at, processed_at from wager_transactions where id = ?",
        [id, tx.id],
      );
      return id;
    };
    await expect(
      insertLedger(await freshTransaction(), randomUUID()),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "ledger_transaction_identity_fk",
    });
    await expect(
      insertLedger(await freshTransaction(), created.id, "USD"),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "ledger_transaction_identity_fk",
    });
    await expect(
      insertLedger(
        await freshTransaction(),
        created.id,
        "BRL",
        "501",
        "0",
        "501",
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "ledger_transaction_identity_fk",
    });
    for (const [money, before, after] of [
      ["-1", "0", "0"],
      ["0", "0", "0"],
      ["100000001", "0", "0"],
      ["500", "-1", "499"],
      ["500", "0", "-1"],
      ["500", "100000001", "0"],
      ["500", "0", "100000001"],
    ] as const) {
      await expect(
        insertLedger(
          await freshTransaction(),
          created.id,
          "BRL",
          money,
          before,
          after,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      insertLedger(
        await freshTransaction(),
        created.id,
        "BRL",
        "500",
        "0",
        "499",
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "ledger_arithmetic" });
    for (const command of [
      "update wallet_ledger_entries set money_minor_units = money_minor_units where id = ?",
      "delete from wallet_ledger_entries where id = ?",
      "truncate wallet_ledger_entries",
    ]) {
      await expect(
        sql.execute(command, command.includes("?") ? [entry.id] : []),
      ).rejects.toMatchObject({ code: "55000" });
    }
    expect(
      await em.fork().findOne(WalletLedgerEntrySchema, entry.id),
    ).toMatchObject({ moneyMinorUnits: 500n, balanceAfterMinorUnits: 500n });
    for (const money of ["-1", "0", "100000001"]) {
      await expect(
        sql.execute(
          "insert into wager_transactions (id, wallet_id, player_id, origin, kind, status, currency, money_minor_units, balance_minor_units, created_at, processed_at) values (?, ?, ?, 'INTERNAL', 'OPENING', 'PENDING', 'BRL', ?, null, now(), null)",
          [randomUUID(), created.id, created.playerId, money],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "transactions_money_range",
      });
    }
    await expect(
      sql.execute(
        "insert into wager_transactions (id, wallet_id, player_id, origin, kind, status, currency, money_minor_units, created_at) values (?, ?, 'another-player', 'INTERNAL', 'OPENING', 'PENDING', 'BRL', 500, now())",
        [randomUUID(), created.id],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "transactions_wallet_identity_fk",
    });
    const message = await em.findOneOrFail(OutboxMessageSchema, {
      aggregateId: tx.id,
    });
    await expect(
      sql.execute(
        "insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts) values (?, ?, ?, ?::jsonb, now(), 0)",
        [
          randomUUID(),
          tx.id,
          message.eventType,
          JSON.stringify({ ...message.payload, eventId: null }),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "outbox_envelope" });
  });

  async function counts(): Promise<number[]> {
    return Promise.all([
      observer.em.fork().count(WalletSchema),
      observer.em.fork().count(WagerTransactionSchema),
      observer.em.fork().count(WalletLedgerEntrySchema),
      observer.em.fork().count(OutboxMessageSchema),
    ]);
  }

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
    expect(positiveResponse.status).toBe(201);
    const positiveValue: unknown = await positiveResponse.json();
    expect(positiveValue).toMatchObject({
      balance: { amount: "1.00", currency: "BRL" },
      version: 1,
    });
    if (!isRecord(positiveValue) || typeof positiveValue.id !== "string")
      throw new Error("Positive wallet response did not contain an ID");
    const positiveGet = await fetch(`${baseUrl}/${positiveValue.id}`);
    expect(positiveGet.status).toBe(200);
    expect(await positiveGet.json()).toEqual(positiveValue);

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
