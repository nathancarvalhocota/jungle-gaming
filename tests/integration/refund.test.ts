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
import { processWorker } from "../support/transaction-process.ts";

describe("REFUND integral in PostgreSQL", () => {
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
  async function refundTarget(amount = "25.37", initial = "100.00") {
    const w = await wallet(initial);
    const bet = input(w, "BET", amount);
    const reference = await useCases.submit(bet, randomUUID());
    return {
      w,
      bet,
      reference,
      refund: input(w, "REFUND", amount, bet.externalTransactionId),
    };
  }
  test("migration preserves existing operations on down/up and refuses down with REFUND", async () => {
    const { w } = await refundTarget();
    await useCases.submit(input(w, "WIN", "0.01"), randomUUID());
    await useCases.submit(input(w, "LOSS", "0.00"), randomUUID());
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    expect(await db.orm.migrator.getExecuted()).toHaveLength(4);
    await state(w.id, "7464", 3, 3, 2, 5);
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.up();
    expect(await db.orm.migrator.getExecuted()).toHaveLength(7);
    const target = await refundTarget();
    await useCases.submit(target.refund, randomUUID());
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await expect(db.orm.migrator.down()).rejects.toMatchObject({
      code: "23514",
      constraint: "transactions_origin_identity",
    });
    expect(await db.orm.migrator.getExecuted()).toHaveLength(5);
    await state(target.w.id, "10000", 3, 2, 2, 4);
    const [index] = await sql<{ name: string | null }[]>(
      "select to_regclass('transactions_processed_reversal_unique')::text as name",
    );
    expect(index?.name).toBe("transactions_processed_reversal_unique");
  });
  test("exact refund credits once, preserves audit/events and replays original result after another movement", async () => {
    const { w, bet, reference, refund } = await refundTarget();
    refund.gameId = "different-game";
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCases.submit(refund, key)),
    );
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    const original = results[0];
    expect(original).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "100.00", currency: "BRL" },
    });
    if (!original) throw new Error("Missing refund result");
    const audit = await useCases.get(original.transactionId);
    expect(audit).toMatchObject({
      kind: "REFUND",
      referenceTransactionId: reference.transactionId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(
      await useCases.getExternal(
        refund.providerId,
        refund.externalTransactionId,
      ),
    ).toEqual(audit);
    const restored = await new TransactionRepository(
      db.observer.em.fork(),
    ).findTransaction(original.transactionId);
    expect(restored?.referenceTransactionId).toBe(reference.transactionId);
    expect(restored?.balance?.toJSON()).toEqual(original.balance);
    const events = await sql<
      { event_type: string; payload: Record<string, unknown> }[]
    >(
      "select event_type,payload from outbox_messages where aggregate_id=? or payload->'data'->>'transactionId'=?",
      [original.transactionId, original.transactionId],
    );
    expect(events).toHaveLength(2);
    expect(
      events.find((e) => e.event_type === "WagerTransactionProcessed")?.payload,
    ).toMatchObject({
      eventType: "WagerTransactionProcessed",
      version: 1,
      correlationId: original.transactionId,
      data: { kind: "REFUND", money: { amount: "25.37", currency: "BRL" } },
    });
    expect(
      events.find((e) => e.event_type === "WalletBalanceChanged")?.payload,
    ).toMatchObject({
      correlationId: original.transactionId,
      data: { direction: "CREDIT" },
    });
    await state(w.id, "10000", 3, 2, 2, 4);
    await useCases.submit(input(w, "BET", "1.00"), randomUUID());
    expect(await useCases.submit(refund, key)).toEqual({
      ...original,
      idempotentReplay: true,
    });
    await expect(
      useCases.submit(
        { ...refund, money: { amount: "1.00", currency: "BRL" } },
        key,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(useCases.submit(refund, randomUUID())).rejects.toMatchObject({
      code: "EXTERNAL_TRANSACTION_CONFLICT",
    });
    const duplicate = await useCases.submit(
      { ...refund, externalTransactionId: randomUUID() },
      randomUUID(),
    );
    expect(duplicate).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_ALREADY_REVERSED",
      balance: { amount: "99.00" },
    });
    await state(w.id, "9900", 4, 4, 3, 7);
  });
  test("amount mismatch is audited before reversal/capacity, and cap overflow preserves wallet", async () => {
    const inclusive = await refundTarget("0.01", "1000000.00");
    expect(await useCases.submit(inclusive.refund, randomUUID())).toMatchObject(
      { status: "PROCESSED", balance: { amount: "1000000.00" } },
    );
    await state(inclusive.w.id, "100000000", 3, 2, 2, 4);
    const { w, refund } = await refundTarget("0.01", "1000000.00");
    await useCases.submit(input(w, "WIN", "0.01"), randomUUID());
    const before = await sql(
      "select balance_minor_units,version,updated_at from wallets where id=?",
      [w.id],
    );
    const rejected = await useCases.submit(refund, `cap-${randomUUID()}`);
    expect(rejected).toMatchObject({
      status: "REJECTED",
      failureCode: "BALANCE_LIMIT_EXCEEDED",
      balance: { amount: "1000000.00" },
    });
    const partial = {
      ...refund,
      externalTransactionId: randomUUID(),
      money: { amount: "0.02", currency: "BRL" },
    };
    const key = randomUUID();
    const mismatch = await useCases.submit(partial, key);
    expect(mismatch).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_AMOUNT_MISMATCH",
    });
    expect(await useCases.submit(partial, key)).toEqual({
      ...mismatch,
      idempotentReplay: true,
    });
    expect(
      await sql(
        "select balance_minor_units,version,updated_at from wallets where id=?",
        [w.id],
      ),
    ).toEqual(before);
    await state(w.id, "100000000", 3, 4, 2, 6);
    const target = await refundTarget();
    await useCases.submit(target.refund, randomUUID());
    expect(
      await useCases.submit(
        {
          ...target.refund,
          externalTransactionId: randomUUID(),
          money: { amount: "0.01", currency: "BRL" },
        },
        randomUUID(),
      ),
    ).toMatchObject({ failureCode: "REFERENCE_AMOUNT_MISMATCH" });
    await state(target.w.id, "10000", 3, 3, 2, 5);
  });
  test("missing and pending references stay pending; context/kind/status precede amount", async () => {
    const w = await wallet();
    const missing = randomUUID();
    const pendingBody = input(w, "REFUND", "1.00", missing);
    const key = randomUUID();
    const pending = await useCases.submit(pendingBody, key);
    expect(pending).toMatchObject({
      status: "PENDING_REFERENCE",
      balance: { amount: "100.00" },
    });
    const bet = { ...input(w, "BET", "1.00"), externalTransactionId: missing };
    await useCases.submit(bet, randomUUID());
    expect(await useCases.submit(pendingBody, key)).toEqual({
      ...pending,
      idempotentReplay: true,
    });
    const pendingBet = input(w, "BET", "2.00");
    const parsed = validateTransaction(pendingBet, randomUUID());
    const pendingId = randomUUID();
    await sql(
      `insert into wager_transactions(id,wallet_id,player_id,origin,kind,status,currency,money_minor_units,created_at,provider_id,external_transaction_id,idempotency_key,payload_hash,round_id,game_id) values (?,?,?,'EXTERNAL','BET','PENDING','BRL',200,now(),?,?,?,?,?,?)`,
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
    const knownPending = await useCases.submit(
      input(w, "REFUND", "1.00", pendingBet.externalTransactionId),
      randomUUID(),
    );
    expect(knownPending).toMatchObject({ status: "PENDING_REFERENCE" });
    expect(await useCases.get(knownPending.transactionId)).toMatchObject({
      referenceTransactionId: pendingId,
    });
    const rejectedBet = input(w, "BET", "200.00");
    await useCases.submit(rejectedBet, randomUUID());
    expect(
      await useCases.submit(
        input(w, "REFUND", "1.00", rejectedBet.externalTransactionId),
        randomUUID(),
      ),
    ).toMatchObject({ failureCode: "REFERENCE_NOT_PROCESSED" });
    expect(
      await useCases.submit(
        {
          ...input(w, "REFUND", "1.00", rejectedBet.externalTransactionId),
          roundId: "other",
        },
        randomUUID(),
      ),
    ).toMatchObject({ failureCode: "REFERENCE_CONTEXT_MISMATCH" });
    expect(
      await useCases.submit(
        input(w, "REFUND", "1.00", pendingBody.externalTransactionId),
        randomUUID(),
      ),
    ).toMatchObject({ failureCode: "REFERENCE_KIND_MISMATCH" });
    const self = input(w, "REFUND", "1.00");
    self.referenceExternalTransactionId = self.externalTransactionId;
    expect(await useCases.submit(self, randomUUID())).toMatchObject({
      failureCode: "REFERENCE_CONTEXT_MISMATCH",
    });
    expect(
      await useCases.submit(
        {
          ...input(w, "REFUND", "1.00", bet.externalTransactionId),
          providerId: "other-provider",
        },
        randomUUID(),
      ),
    ).toMatchObject({ status: "PENDING_REFERENCE" });
    const other = await refundTarget();
    expect(
      await useCases.submit(
        input(w, "REFUND", "25.37", other.bet.externalTransactionId),
        randomUUID(),
      ),
    ).toMatchObject({ failureCode: "REFERENCE_CONTEXT_MISMATCH" });
    await state(w.id, "9900", 2, 11, 1, 11);
  });
  test("all REFUND writes roll back atomically after each actual write", async () => {
    for (const mode of ["processed", "pending", "rejected"] as const) {
      for (let stop = 1; stop <= (mode === "processed" ? 6 : 3); stop++) {
        const { w, refund } = await refundTarget();
        const body =
          mode === "pending"
            ? { ...refund, referenceExternalTransactionId: "missing" }
            : mode === "rejected"
              ? { ...refund, money: { amount: "0.01", currency: "BRL" } }
              : refund;
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
                        await state(w.id, "7463", 2, 1, 1, 2);
                        if (count === stop)
                          throw new Error("Injected refund write failure");
                      }
                      return result;
                    };
                  },
                }) as TransactionRepositoryPort,
              ),
            ),
        };
        await expect(
          new TransactionUseCases(uow).submit(body, randomUUID()),
        ).rejects.toThrow("Injected refund write failure");
        expect(count).toBe(stop);
        await state(w.id, "7463", 2, 1, 1, 2);
      }
    }
  });
  test("three independent processes compete with distinct IDs/keys for one reference", async () => {
    const { w, refund } = await refundTarget();
    const workers = Array.from({ length: 3 }, () =>
      processWorker(db, [
        {
          body: { ...refund, externalTransactionId: randomUUID() },
          key: randomUUID(),
        },
      ]),
    );
    try {
      const pids = await Promise.all(workers.map((w) => w.ready));
      expect(new Set(pids).size).toBe(3);
      expect(pids.every((pid) => pid !== process.pid)).toBe(true);
      for (const worker of workers) worker.child.send("start");
      const results = (await Promise.all(workers.map((w) => w.result))).flat();
      expect(results.filter((r) => "error" in r)).toHaveLength(0);
      expect(
        results.filter(
          (r) =>
            "result" in r &&
            "status" in r.result &&
            r.result.status === "PROCESSED",
        ),
      ).toHaveLength(1);
      expect(
        results.filter(
          (r) =>
            "result" in r &&
            "failureCode" in r.result &&
            r.result.failureCode === "REFERENCE_ALREADY_REVERSED",
        ),
      ).toHaveLength(2);
      expect(await Promise.all(workers.map((w) => w.child.exited))).toEqual([
        0, 0, 0,
      ]);
      await state(w.id, "10000", 3, 4, 2, 6);
    } finally {
      for (const worker of workers)
        if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all(workers.map((w) => w.child.exited));
    }
  });
  test("SQL enforces required reference, positive money, valid failures and shared processed reversal uniqueness", async () => {
    const { w, refund, reference } = await refundTarget();
    const original = await useCases.submit(refund, randomUUID());
    for (const [assignment, constraint] of [
      ["money_minor_units=0", "transactions_money_range"],
      [
        "reference_external_transaction_id=null,reference_transaction_id=null",
        "transactions_reference_shape",
      ],
      ["reference_external_transaction_id=''", "transactions_reference_shape"],
      ["reference_transaction_id=id", "transactions_reference_shape"],
      ["status='REJECTED',failure_code=null", "transactions_processing_state"],
      ["status='FAILED'", "transactions_processing_state"],
      [
        "status='REJECTED',failure_code='INSUFFICIENT_FUNDS'",
        "transactions_processing_state",
      ],
    ])
      await expect(
        sql(`update wager_transactions set ${assignment} where id=?`, [
          original.transactionId,
        ]),
      ).rejects.toMatchObject({ code: "23514", constraint });
    const rejected = await useCases.submit(
      { ...refund, externalTransactionId: randomUUID() },
      randomUUID(),
    );
    await expect(
      sql(
        "update wager_transactions set status='PROCESSED',failure_code=null where id=?",
        [rejected.transactionId],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "transactions_processed_reversal_unique",
    });
    const [index] = await sql<{ definition: string }[]>(
      "select indexdef as definition from pg_indexes where indexname='transactions_processed_reversal_unique'",
    );
    expect(index?.definition).toContain("ROLLBACK");
    expect(index?.definition).toContain("REFUND");
    expect(await useCases.get(rejected.transactionId)).toMatchObject({
      referenceTransactionId: reference.transactionId,
    });
    await state(w.id, "10000", 3, 3, 2, 5);
  });
  test("specific unique violation rolls back before retry response; retry persists rejection in a new unit of work", async () => {
    const { w, refund } = await refundTarget();
    await useCases.submit(refund, randomUUID());
    const body = { ...refund, externalTransactionId: randomUUID() };
    const key = randomUUID();
    let attempted = 0;
    const controlled: TransactionUnitOfWork = {
      execute: (operation) =>
        new MikroOrmTransactionUnitOfWork(db.orm.em).execute((repository) => {
          repository.hasProcessedReversal = async () => {
            attempted++;
            return false;
          };
          return operation(repository);
        }),
    };
    await expect(
      new TransactionUseCases(controlled).submit(body, key),
    ).rejects.toMatchObject({
      code: "TRANSACTION_RETRY_REQUIRED",
      statusCode: 503,
      cause: {
        code: "23505",
        constraint: "transactions_processed_reversal_unique",
      },
    });
    expect(attempted).toBe(1);
    expect(
      await new TransactionRepository(db.observer.em.fork()).findByKey(key),
    ).toBeUndefined();
    await state(w.id, "10000", 3, 2, 2, 4);
    const retried = await useCases.submit(body, key);
    expect(retried).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_ALREADY_REVERSED",
      idempotentReplay: false,
    });
    expect(await useCases.submit(body, key)).toEqual({
      ...retried,
      idempotentReplay: true,
    });
    await state(w.id, "10000", 3, 3, 2, 5);
  });
  test("HTTP exposes applied/replay, pending/replay, audited rejections, validation and reference queries", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.url;
    const app = await createApplication();
    try {
      await app.listen(0, "127.0.0.1");
      const base = await app.getUrl();
      const { w, refund, reference } = await refundTarget();
      const post = (body: unknown, key: string) =>
        fetch(`${base}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        });
      const key = randomUUID();
      const applied = await post(refund, key);
      expect(applied.status).toBe(201);
      const result = (await applied.json()) as { transactionId: string };
      expect((await post(refund, key)).status).toBe(200);
      for (const path of [
        `/wagering/transactions/${result.transactionId}`,
        `/providers/${refund.providerId}/wagering/transactions/${refund.externalTransactionId}`,
      ]) {
        const response = await fetch(base + path);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          kind: "REFUND",
          referenceTransactionId: reference.transactionId,
        });
      }
      for (const [body, expected] of [
        [
          { ...refund, externalTransactionId: randomUUID() },
          "REFERENCE_ALREADY_REVERSED",
        ],
        [
          {
            ...refund,
            externalTransactionId: randomUUID(),
            money: { amount: "0.01", currency: "BRL" },
          },
          "REFERENCE_AMOUNT_MISMATCH",
        ],
      ] as const) {
        const rejectKey = randomUUID();
        for (const replay of [false, true]) {
          const response = await post(body, rejectKey);
          expect(response.status).toBe(422);
          expect(await response.json()).toMatchObject({
            failureCode: expected,
            idempotentReplay: replay,
          });
        }
      }
      const missing = {
        ...refund,
        externalTransactionId: randomUUID(),
        referenceExternalTransactionId: "missing-http",
      };
      const pendingKey = randomUUID();
      expect((await post(missing, pendingKey)).status).toBe(202);
      expect((await post(missing, pendingKey)).status).toBe(202);
      const { referenceExternalTransactionId: _reference, ...noReference } =
        refund;
      for (const body of [
        noReference,
        { ...refund, referenceExternalTransactionId: null },
        { ...refund, money: { amount: "0.00", currency: "BRL" } },
      ])
        expect((await post(body, randomUUID())).status).toBe(400);
      await state(w.id, "10000", 3, 5, 2, 7);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
