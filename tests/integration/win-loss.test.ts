import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApplication } from "../../src/main.ts";
import { TransactionUseCases } from "../../src/modules/wagering/application/transaction.use-cases.ts";
import { validateTransaction } from "../../src/modules/wagering/application/transaction-input.ts";
import type {
  TransactionRepositoryPort,
  TransactionUnitOfWork,
} from "../../src/modules/wagering/application/transaction-ports.ts";
import { WalletUseCases } from "../../src/modules/wagering/application/wallet.use-cases.ts";
import {
  MikroOrmTransactionUnitOfWork,
  TransactionRepository,
} from "../../src/modules/wagering/infrastructure/persistence/transaction.repository.ts";
import { MikroOrmWalletUnitOfWork } from "../../src/modules/wagering/infrastructure/persistence/wallet.unit-of-work.ts";
import {
  assertBetDatabase,
  createBetDatabase,
} from "../support/bet-database.ts";

describe("WIN/LOSS and optional references in PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof createBetDatabase>>;
  let useCases: TransactionUseCases;
  beforeAll(async () => {
    db = await createBetDatabase();
    useCases = new TransactionUseCases(
      new MikroOrmTransactionUnitOfWork(db.orm.em),
    );
  });
  afterAll(async () => {
    await db?.close();
  });
  const sql = <T extends object[]>(query: string, params: unknown[] = []) =>
    db.observer.em.getConnection().execute<T>(query, params);
  async function wallet(amount = "100.00") {
    return new WalletUseCases(new MikroOrmWalletUnitOfWork(db.orm.em)).create({
      playerId: randomUUID(),
      initialBalance: { amount, currency: "BRL" },
    });
  }
  function input(
    w: { id: string; playerId: string },
    kind = "WIN",
    amount = "25.37",
    referenceExternalTransactionId?: string,
  ) {
    return {
      providerId: "provider",
      externalTransactionId: randomUUID(),
      playerId: w.playerId,
      walletId: w.id,
      roundId: "round",
      gameId: "game",
      kind,
      money: { amount, currency: "BRL" },
      ...(referenceExternalTransactionId
        ? { referenceExternalTransactionId }
        : {}),
    };
  }
  async function state(
    id: string,
    balance: string,
    version: number,
    transactions: number,
    entries: number,
    events: number,
  ) {
    const [row] = await sql<
      {
        balance: string;
        reconstructed: string;
        version: number;
        transactions: number;
        entries: number;
        events: number;
      }[]
    >(
      `select balance_minor_units::text as balance, version,
      coalesce((select sum(case when direction='CREDIT' then money_minor_units else -money_minor_units end) from wallet_ledger_entries where wallet_id=w.id),0)::text as reconstructed,
      (select count(*)::int from wager_transactions where wallet_id=w.id and kind <> 'OPENING') as transactions,
      (select count(*)::int from wallet_ledger_entries l join wager_transactions t on t.id=l.transaction_id where t.wallet_id=w.id and t.kind <> 'OPENING') as entries,
      (select count(*)::int from outbox_messages o join wager_transactions t on o.payload->'data'->>'transactionId'=t.id::text where t.wallet_id=w.id and t.kind <> 'OPENING') as events from wallets w where id=?`,
      [id],
    );
    expect(row).toEqual({
      balance,
      reconstructed: balance,
      version,
      transactions,
      entries,
      events,
    });
  }
  test("incremental migration down/up preserves OPENING/BET and the immutable ledger", async () => {
    const w = await wallet();
    await useCases.submit(input(w, "BET", "1.00"), randomUUID());
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    expect(await db.orm.migrator.getExecuted()).toHaveLength(3);
    await state(w.id, "9900", 2, 1, 1, 2);
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.up();
    expect(await db.orm.migrator.getExecuted()).toHaveLength(6);
    await expect(
      sql(
        "update wallet_ledger_entries set money_minor_units=money_minor_units where wallet_id=?",
        [w.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });
  test("WIN credits exact cents, LOSS zero/positive never change ledger/version and replay preserves original balances", async () => {
    const w = await wallet();
    const win = input(w);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCases.submit(win, key)),
    );
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    await state(w.id, "12537", 2, 1, 1, 2);
    for (const amount of ["0.00", "999999.99"]) {
      const loss = input(w, "LOSS", amount);
      const lossKey = randomUUID();
      const before = await sql(
        "select balance_minor_units,version,updated_at from wallets where id=?",
        [w.id],
      );
      const result = await useCases.submit(loss, lossKey);
      expect(result).toMatchObject({
        status: "PROCESSED",
        balance: { amount: "125.37" },
      });
      expect(await useCases.submit(loss, lossKey)).toMatchObject({
        ...result,
        idempotentReplay: true,
      });
      expect(
        await sql(
          "select balance_minor_units,version,updated_at from wallets where id=?",
          [w.id],
        ),
      ).toEqual(before);
      const events = await sql<
        { event_type: string; payload: Record<string, unknown> }[]
      >(
        "select event_type,payload from outbox_messages where aggregate_id=? or payload->'data'->>'transactionId'=?",
        [result.transactionId, result.transactionId],
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: "WagerTransactionProcessed",
        payload: {
          correlationId: result.transactionId,
          data: { kind: "LOSS", money: { amount, currency: "BRL" } },
        },
      });
    }
    await useCases.submit(input(w, "BET", "5.00"), randomUUID());
    expect(await useCases.submit(win, key)).toMatchObject({
      balance: { amount: "125.37" },
      idempotentReplay: true,
    });
    await state(w.id, "12037", 3, 4, 2, 6);
    const [entry] = await sql<{ direction: string; money: string }[]>(
      "select direction, money_minor_units::text as money from wallet_ledger_entries where transaction_id=?",
      [results[0]?.transactionId],
    );
    expect(entry).toEqual({ direction: "CREDIT", money: "2537" });
  });
  test("processed BET references accept different game/value and multiple WIN/LOSS, expose both reference IDs", async () => {
    const w = await wallet();
    const bet = input(w, "BET", "10.00");
    const reference = await useCases.submit(bet, randomUUID());
    for (const kind of ["WIN", "WIN", "LOSS"]) {
      const body = {
        ...input(w, kind, "20.00", bet.externalTransactionId),
        gameId: "different-game",
      };
      const result = await useCases.submit(body, randomUUID());
      expect(String(result.status)).toBe("PROCESSED");
      const audit = await useCases.get(result.transactionId);
      expect(audit).toMatchObject({
        referenceExternalTransactionId: bet.externalTransactionId,
        referenceTransactionId: reference.transactionId,
      });
      expect(
        await useCases.getExternal(body.providerId, body.externalTransactionId),
      ).toEqual(audit);
      const restored = await new TransactionRepository(
        db.observer.em.fork(),
      ).findTransaction(result.transactionId);
      expect(restored?.referenceTransactionId).toBe(reference.transactionId);
    }
    await state(w.id, "13000", 4, 4, 3, 7);
  });
  test("missing reference is durable, replay never reprocesses even after BET appears and uses original snapshot", async () => {
    const w = await wallet();
    const missing = randomUUID();
    const body = input(w, "WIN", "5.00", missing);
    const key = randomUUID();
    const walletBefore = await sql(
      "select balance_minor_units,version,updated_at from wallets where id=?",
      [w.id],
    );
    const pending = await useCases.submit(body, key);
    expect(
      await sql(
        "select balance_minor_units,version,updated_at from wallets where id=?",
        [w.id],
      ),
    ).toEqual(walletBefore);
    expect(pending).toMatchObject({
      status: "PENDING_REFERENCE",
      balance: { amount: "100.00" },
    });
    const audit = await useCases.get(pending.transactionId);
    expect(audit).toMatchObject({ referenceExternalTransactionId: missing });
    expect(audit.referenceTransactionId).toBeUndefined();
    expect(audit.processedAt).toBeUndefined();
    expect(audit.failureCode).toBeUndefined();
    await state(w.id, "10000", 1, 1, 0, 1);
    await useCases.submit(
      { ...input(w, "BET", "10.00"), externalTransactionId: missing },
      randomUUID(),
    );
    expect(await useCases.submit(body, key)).toMatchObject({
      ...pending,
      idempotentReplay: true,
    });
    await expect(
      useCases.submit(
        { ...body, referenceExternalTransactionId: "changed" },
        key,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(useCases.submit(body, randomUUID())).rejects.toMatchObject({
      code: "EXTERNAL_TRANSACTION_CONFLICT",
    });
    await state(w.id, "9000", 2, 2, 1, 3);
    const [event] = await sql<{ payload: Record<string, unknown> }[]>(
      "select payload from outbox_messages where aggregate_id=?",
      [pending.transactionId],
    );
    expect(event?.payload).toMatchObject({
      eventType: "WagerTransactionPendingReference",
      version: 1,
      correlationId: pending.transactionId,
      data: {
        referenceExternalTransactionId: missing,
        balance: { amount: "100.00", currency: "BRL" },
      },
    });
  });
  test("known pending BET retains resolved ID; rejected BET rejects, context and kind precede status", async () => {
    const w = await wallet();
    const pendingBet = input(w, "BET", "1.00");
    const parsed = validateTransaction(pendingBet, randomUUID());
    const pendingId = randomUUID();
    await sql(
      `insert into wager_transactions (id,wallet_id,player_id,origin,kind,status,currency,money_minor_units,created_at,provider_id,external_transaction_id,idempotency_key,payload_hash,round_id,game_id) values (?,?,?,'EXTERNAL','BET','PENDING','BRL',100,now(),?,?,?,?,?,?)`,
      [
        pendingId,
        w.id,
        w.playerId,
        pendingBet.providerId,
        pendingBet.externalTransactionId,
        parsed.key,
        parsed.hash,
        pendingBet.roundId,
        pendingBet.gameId,
      ],
    );
    const pending = await useCases.submit(
      input(w, "WIN", "1.00", pendingBet.externalTransactionId),
      randomUUID(),
    );
    expect(
      (await useCases.get(pending.transactionId)).referenceTransactionId,
    ).toBe(pendingId);
    const rejectBet = input(w, "BET", "200.00");
    const rejected = await useCases.submit(rejectBet, randomUUID());
    const rejectedWin = await useCases.submit(
      input(w, "WIN", "1.00", rejectBet.externalTransactionId),
      randomUUID(),
    );
    expect(String(rejectedWin.failureCode)).toBe("REFERENCE_NOT_PROCESSED");
    expect(
      (await useCases.get(rejectedWin.transactionId)).referenceTransactionId,
    ).toBe(rejected.transactionId);
    const wrongRound = await useCases.submit(
      {
        ...input(w, "LOSS", "0.00", rejectBet.externalTransactionId),
        roundId: "other",
      },
      randomUUID(),
    );
    expect(String(wrongRound.failureCode)).toBe("REFERENCE_CONTEXT_MISMATCH");
    expect(
      (await useCases.get(wrongRound.transactionId)).referenceTransactionId,
    ).toBeUndefined();
    const wrongKind = await useCases.submit(
      input(
        w,
        "WIN",
        "1.00",
        (await useCases.get(pending.transactionId)).externalTransactionId,
      ),
      randomUUID(),
    );
    expect(String(wrongKind.failureCode)).toBe("REFERENCE_KIND_MISMATCH");
    expect(
      (await useCases.get(wrongKind.transactionId)).referenceTransactionId,
    ).toBe(pending.transactionId);
    await state(w.id, "10000", 1, 6, 0, 5);
  });
  test("reference namespace, wallet/player/currency context and self-reference never credit", async () => {
    const w = await wallet();
    const other = await wallet();
    const bet = input(other, "BET", "1.00");
    await useCases.submit(bet, randomUUID());
    const mismatch = await useCases.submit(
      input(w, "WIN", "1.00", bet.externalTransactionId),
      randomUUID(),
    );
    expect(String(mismatch.failureCode)).toBe("REFERENCE_CONTEXT_MISMATCH");
    const namespace = await useCases.submit(
      {
        ...input(w, "WIN", "1.00", bet.externalTransactionId),
        providerId: "different-provider",
      },
      randomUUID(),
    );
    expect(String(namespace.status)).toBe("PENDING_REFERENCE");
    const self = input(w);
    self.referenceExternalTransactionId = self.externalTransactionId;
    expect(
      String((await useCases.submit(self, randomUUID())).failureCode),
    ).toBe("REFERENCE_CONTEXT_MISMATCH");
    const usdWallet = randomUUID();
    const usdTransaction = randomUUID();
    const usdExternal = randomUUID();
    await sql(
      "insert into wallets (id,player_id,currency,balance_minor_units,version,created_at,updated_at) values (?,?,'USD',0,1,now(),now())",
      [usdWallet, w.playerId],
    );
    await sql(
      `insert into wager_transactions (id,wallet_id,player_id,origin,kind,status,currency,money_minor_units,created_at,provider_id,external_transaction_id,idempotency_key,payload_hash,round_id,game_id) values (?,?,?,'EXTERNAL','BET','PENDING','USD',100,now(),'provider',?,?,?,'round','game')`,
      [
        usdTransaction,
        usdWallet,
        w.playerId,
        usdExternal,
        randomUUID(),
        validateTransaction(input(w), "key").hash,
      ],
    );
    expect(
      String(
        (
          await useCases.submit(
            input(w, "WIN", "1.00", usdExternal),
            randomUUID(),
          )
        ).failureCode,
      ),
    ).toBe("REFERENCE_CONTEXT_MISMATCH");
    await state(w.id, "10000", 1, 4, 0, 4);
    await state(other.id, "9900", 2, 1, 1, 2);
    await state(usdWallet, "0", 1, 1, 0, 0);
  });
  test("inclusive cap credits exact final cent; overflowing WIN is a persisted rejection with replay", async () => {
    const w = await wallet("999999.99");
    await useCases.submit(input(w, "WIN", "0.01"), randomUUID());
    const overflow = input(w, "WIN", "0.01");
    const key = randomUUID();
    const before = await sql(
      "select balance_minor_units,version,updated_at from wallets where id=?",
      [w.id],
    );
    const rejected = await useCases.submit(overflow, key);
    expect(
      await sql(
        "select balance_minor_units,version,updated_at from wallets where id=?",
        [w.id],
      ),
    ).toEqual(before);
    expect(rejected).toMatchObject({
      status: "REJECTED",
      failureCode: "BALANCE_LIMIT_EXCEEDED",
      balance: { amount: "1000000.00" },
    });
    expect(await useCases.submit(overflow, key)).toMatchObject({
      ...rejected,
      idempotentReplay: true,
    });
    await state(w.id, "100000000", 2, 2, 1, 3);
    await expect(
      useCases.submit(input(w, "WIN", "0.00"), randomUUID()),
    ).rejects.toMatchObject({ code: "INVALID_TRANSACTION_INPUT" });
    await state(w.id, "100000000", 2, 2, 1, 3);
  });
  test("rollback after each real write covers WIN, LOSS, pending and rejection; reference query errors abort", async () => {
    for (const [kind, amount, reference, writes] of [
      ["WIN", "1.00", undefined, 6],
      ["LOSS", "0.00", undefined, 3],
      ["WIN", "1.00", "missing", 3],
      ["WIN", "1000000.00", undefined, 3],
    ] as const) {
      for (let stop = 1; stop <= writes; stop++) {
        const w = await wallet();
        let count = 0;
        const uow: TransactionUnitOfWork = {
          execute: (operation) =>
            new MikroOrmTransactionUnitOfWork(db.orm.em).execute((repository) =>
              operation(
                new Proxy(repository, {
                  get(target, property) {
                    const member = Reflect.get(target, property);
                    if (typeof member !== "function") return member;
                    return async (...args: unknown[]) => {
                      const result = await member.apply(target, args);
                      if (
                        [
                          "claim",
                          "saveTransaction",
                          "saveWallet",
                          "createLedgerEntry",
                          "enqueue",
                        ].includes(String(property))
                      ) {
                        count++;
                        await state(w.id, "10000", 1, 0, 0, 0);
                        if (count === stop)
                          throw new Error("Injected write failure");
                      }
                      return result;
                    };
                  },
                }) as TransactionRepositoryPort,
              ),
            ),
        };
        await expect(
          new TransactionUseCases(uow).submit(
            input(w, kind, amount, reference),
            randomUUID(),
          ),
        ).rejects.toThrow("Injected write failure");
        expect(count).toBe(stop);
        await state(w.id, "10000", 1, 0, 0, 0);
      }
    }
    const w = await wallet();
    const uow: TransactionUnitOfWork = {
      execute: (operation) =>
        db.orm.em.fork().transactional((em) => {
          const repository = new TransactionRepository(em);
          repository.findExternal = async () => {
            await em.execute(
              "select missing_reference_column from wager_transactions",
            );
            return undefined;
          };
          return operation(repository);
        }),
    };
    await expect(
      new TransactionUseCases(uow).submit(
        input(w, "WIN", "1.00", "missing"),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "42703" });
    await state(w.id, "10000", 1, 0, 0, 0);
  });
  test("schema rejects invalid zero, references, statuses and failure codes with named constraints", async () => {
    const w = await wallet();
    const win = await useCases.submit(input(w), randomUUID());
    const violations = [
      ["money_minor_units=0", "transactions_money_range"],
      ["money_minor_units=-1", "transactions_money_range"],
      ["money_minor_units=100000001", "transactions_money_range"],
      [
        "reference_external_transaction_id='',reference_transaction_id=id",
        "transactions_reference_shape",
      ],
      [
        "reference_transaction_id=id,reference_external_transaction_id='self'",
        "transactions_reference_shape",
      ],
      [
        "reference_external_transaction_id='absent'",
        "transactions_processing_state",
      ],
      ["status='PENDING_REFERENCE'", "transactions_processing_state"],
      ["status='REJECTED',failure_code=null", "transactions_processing_state"],
      ["status='FAILED'", "transactions_processing_state"],
    ];
    for (const [assignment, constraint] of violations)
      await expect(
        sql(`update wager_transactions set ${assignment} where id=?`, [
          win.transactionId,
        ]),
      ).rejects.toMatchObject({ code: "23514", constraint });
    await expect(
      sql(
        "update wager_transactions set reference_external_transaction_id='absent', reference_transaction_id=? where id=?",
        [randomUUID(), win.transactionId],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "transactions_reference_fk",
    });
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await expect(db.orm.migrator.down()).rejects.toMatchObject({
      code: "23514",
      constraint: "transactions_origin_identity",
    });
    expect(await db.orm.migrator.getExecuted()).toHaveLength(4);
    await state(w.id, "12537", 2, 1, 1, 2);
  });
  test("HTTP returns 201/200 for applied, 202 for pending/replay, 422 for rejected and 400 for zero WIN", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.url;
    const app = await createApplication();
    try {
      await app.listen(0, "127.0.0.1");
      const base = await app.getUrl();
      const w = await wallet();
      const post = (body: unknown, key: string) =>
        fetch(`${base}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        });
      const win = input(w);
      const key = randomUUID();
      expect((await post(win, key)).status).toBe(201);
      expect((await post(win, key)).status).toBe(200);
      expect((await post(input(w, "LOSS", "0.00"), randomUUID())).status).toBe(
        201,
      );
      const pending = input(w, "WIN", "1.00", "missing-http");
      const pendingKey = randomUUID();
      for (const replay of [false, true]) {
        const response = await post(pending, pendingKey);
        expect(response.status).toBe(202);
        const result = (await response.json()) as { transactionId: string };
        expect(result).toMatchObject({
          status: "PENDING_REFERENCE",
          idempotentReplay: replay,
        });
        expect(
          (await fetch(`${base}/wagering/transactions/${result.transactionId}`))
            .status,
        ).toBe(200);
      }
      const cap = input(w, "WIN", "1000000.00");
      const capKey = randomUUID();
      for (const replay of [false, true]) {
        const response = await post(cap, capKey);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          failureCode: "BALANCE_LIMIT_EXCEEDED",
          idempotentReplay: replay,
        });
      }
      expect((await post(input(w, "WIN", "0.00"), randomUUID())).status).toBe(
        400,
      );
      expect(
        (
          await post(
            { ...win, referenceExternalTransactionId: null },
            randomUUID(),
          )
        ).status,
      ).toBe(400);
      await state(w.id, "12537", 2, 4, 1, 5);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
