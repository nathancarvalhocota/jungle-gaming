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

describe("ROLLBACK integral in PostgreSQL", () => {
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
    kind: string,
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
  async function target(
    kind: "BET" | "WIN" | "REFUND" = "BET",
    amount = "25.37",
    initial = "100.00",
  ) {
    const w = await wallet(initial);
    let reference = input(w, kind, amount);
    if (kind === "REFUND") {
      const bet = input(w, "BET", amount);
      await useCases.submit(bet, randomUUID());
      reference = input(w, kind, amount, bet.externalTransactionId);
    }
    const result = await useCases.submit(reference, randomUUID());
    return {
      w,
      reference,
      result,
      rollback: {
        ...input(w, "ROLLBACK", amount, reference.externalTransactionId),
        gameId: "other-game",
      },
    };
  }
  async function snapshot(id: string) {
    const [row] = await sql<
      {
        balance: string;
        reconstructed: string;
        version: number;
        updated_at: Date;
        transactions: number;
        entries: number;
        events: number;
      }[]
    >(
      `select balance_minor_units::text as balance, version, updated_at,
      coalesce((select sum(case when direction='CREDIT' then money_minor_units else -money_minor_units end) from wallet_ledger_entries where wallet_id=w.id),0)::text as reconstructed,
      (select count(*)::int from wager_transactions where wallet_id=w.id) as transactions,
      (select count(*)::int from wallet_ledger_entries where wallet_id=w.id) as entries,
      (select count(*)::int from outbox_messages where payload->'data'->>'walletId'=w.id::text) as events from wallets w where id=?`,
      [id],
    );
    if (!row) throw new Error("Wallet snapshot missing");
    expect(row.balance).toBe(row.reconstructed);
    return row;
  }
  async function eventTypes(id: string) {
    return sql<{ event_type: string; payload: Record<string, unknown> }[]>(
      "select event_type,payload from outbox_messages where payload->'data'->>'transactionId'=? order by event_type",
      [id],
    );
  }
  test("incremental migration preserves prior kinds and shared index, then refuses destructive down", async () => {
    const { w, rollback } = await target("REFUND");
    await useCases.submit(input(w, "WIN", "0.01"), randomUUID());
    await useCases.submit(input(w, "LOSS", "0.00"), randomUUID());
    const before = await snapshot(w.id);
    const [index] = await sql<{ oid: number }[]>(
      "select 'transactions_processed_reversal_unique'::regclass::oid as oid",
    );
    if (!index) throw new Error("Shared reversal index missing");
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    expect(await db.orm.migrator.getExecuted()).toHaveLength(5);
    expect(await snapshot(w.id)).toEqual(before);
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.up();
    expect(await db.orm.migrator.getExecuted()).toHaveLength(7);
    expect(await snapshot(w.id)).toEqual(before);
    expect(
      await sql(
        "select 'transactions_processed_reversal_unique'::regclass::oid as oid",
      ),
    ).toEqual([index]);
    await useCases.submit(rollback, randomUUID());
    const applied = await snapshot(w.id);
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await expect(db.orm.migrator.down()).rejects.toMatchObject({
      code: "23514",
      constraint: "transactions_origin_identity",
    });
    expect(await db.orm.migrator.getExecuted()).toHaveLength(6);
    expect(await snapshot(w.id)).toEqual(applied);
    expect(
      await sql(
        "select 'transactions_processed_reversal_unique'::regclass::oid as oid",
      ),
    ).toEqual([index]);
  });
  test("inverts BET, WIN and REFUND exactly, preserves original records, audit and immutable ledger", async () => {
    for (const kind of ["BET", "WIN", "REFUND"] as const) {
      const { w, reference, result, rollback } = await target(kind);
      const original = await useCases.get(result.transactionId);
      const before = await snapshot(w.id);
      const applied = await useCases.submit(rollback, randomUUID());
      expect(applied).toMatchObject({
        status: "PROCESSED",
        balance: {
          amount: kind === "REFUND" ? "74.63" : "100.00",
          currency: "BRL",
        },
      });
      const audit = await useCases.get(applied.transactionId);
      expect(audit).toMatchObject({
        kind: "ROLLBACK",
        referenceTransactionId: result.transactionId,
        referenceExternalTransactionId: reference.externalTransactionId,
      });
      expect(
        await useCases.getExternal(
          rollback.providerId,
          rollback.externalTransactionId,
        ),
      ).toEqual(audit);
      expect(await useCases.get(result.transactionId)).toEqual(original);
      const restored = await new TransactionRepository(
        db.observer.em.fork(),
      ).findTransaction(applied.transactionId);
      expect(restored?.balance?.toJSON()).toEqual(applied.balance);
      expect(restored?.referenceTransactionId).toBe(result.transactionId);
      const after = await snapshot(w.id);
      expect(after.version).toBe(before.version + 1);
      expect(after.entries).toBe(before.entries + 1);
      const [entry] = await sql<{ direction: string; money: string }[]>(
        "select direction,money_minor_units::text as money from wallet_ledger_entries where transaction_id=?",
        [applied.transactionId],
      );
      expect(entry).toEqual({
        direction: kind === "BET" ? "CREDIT" : "DEBIT",
        money: "2537",
      });
      const events = await eventTypes(applied.transactionId);
      expect(events.map((e) => e.event_type)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
      expect(events[0]?.payload).toMatchObject({
        eventType: "WagerTransactionProcessed",
        version: 1,
        correlationId: applied.transactionId,
        data: { kind: "ROLLBACK", money: { amount: "25.37", currency: "BRL" } },
      });
      expect(events[1]?.payload).toMatchObject({
        eventType: "WalletBalanceChanged",
        version: 1,
        correlationId: applied.transactionId,
        data: { direction: entry?.direction },
      });
      await expect(
        sql(
          "update wallet_ledger_entries set money_minor_units=money_minor_units where transaction_id=?",
          [applied.transactionId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      if (kind === "REFUND") {
        const repeatedBet = await useCases.submit(
          input(
            w,
            "ROLLBACK",
            "25.37",
            original.referenceExternalTransactionId,
          ),
          randomUUID(),
        );
        expect(repeatedBet).toMatchObject({
          failureCode: "REFERENCE_ALREADY_REVERSED",
        });
      }
      if (kind === "BET") {
        expect(
          await useCases.submit(
            input(w, "REFUND", "25.37", reference.externalTransactionId),
            randomUUID(),
          ),
        ).toMatchObject({ failureCode: "REFERENCE_ALREADY_REVERSED" });
        await snapshot(w.id);
      }
    }
    const exact = await target("WIN", "0.01", "0.00");
    expect(await useCases.submit(exact.rollback, randomUUID())).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "0.00", currency: "BRL" },
    });
    expect((await snapshot(exact.w.id)).balance).toBe("0");
  });
  test("duplicates and conflicts preserve original snapshots after subsequent movements", async () => {
    const { w, rollback } = await target();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCases.submit(rollback, key)),
    );
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    const original = results[0];
    if (!original) throw new Error("Missing result");
    const before = await snapshot(w.id);
    expect(await eventTypes(original.transactionId)).toHaveLength(2);
    await useCases.submit(input(w, "BET", "1.00"), randomUUID());
    expect(await useCases.submit(rollback, key)).toEqual({
      ...original,
      idempotentReplay: true,
    });
    await expect(
      useCases.submit({ ...rollback, gameId: "changed" }, key),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(useCases.submit(rollback, randomUUID())).rejects.toMatchObject(
      { code: "EXTERNAL_TRANSACTION_CONFLICT" },
    );
    const after = await snapshot(w.id);
    expect(after.transactions).toBe(before.transactions + 1);
    expect(after.entries).toBe(before.entries + 1);
    expect(await eventTypes(original.transactionId)).toHaveLength(2);
  });
  test("insufficient reversal funds and credit overflow are audited, terminal and stable on replay", async () => {
    for (const kind of ["WIN", "REFUND"] as const) {
      const { w, rollback } = await target(kind);
      await useCases.submit(
        input(w, "BET", kind === "WIN" ? "125.37" : "100.00"),
        randomUUID(),
      );
      const before = await snapshot(w.id);
      const key = randomUUID();
      const rejected = await useCases.submit(rollback, key);
      expect(rejected).toMatchObject({
        status: "REJECTED",
        failureCode: "REVERSAL_INSUFFICIENT_FUNDS",
        balance: { amount: "0.00" },
      });
      const after = await snapshot(w.id);
      expect(after).toEqual({
        ...before,
        transactions: before.transactions + 1,
        events: before.events + 1,
      });
      expect(
        (await eventTypes(rejected.transactionId)).map((e) => e.event_type),
      ).toEqual(["WagerTransactionRejected"]);
      await useCases.submit(input(w, "WIN", "50.00"), randomUUID());
      expect(await useCases.submit(rollback, key)).toEqual({
        ...rejected,
        idempotentReplay: true,
      });
      expect(await useCases.get(rejected.transactionId)).toMatchObject({
        failureCode: "REVERSAL_INSUFFICIENT_FUNDS",
        balance: { amount: "0.00" },
      });
    }
    const inclusive = await target("BET", "0.01", "1000000.00");
    expect(
      await useCases.submit(inclusive.rollback, randomUUID()),
    ).toMatchObject({ status: "PROCESSED", balance: { amount: "1000000.00" } });
    const capped = await target("BET", "0.01", "1000000.00");
    await useCases.submit(input(capped.w, "WIN", "0.01"), randomUUID());
    const before = await snapshot(capped.w.id);
    const key = randomUUID();
    const rejected = await useCases.submit(capped.rollback, key);
    expect(rejected).toMatchObject({ failureCode: "BALANCE_LIMIT_EXCEEDED" });
    expect(await useCases.submit(capped.rollback, key)).toEqual({
      ...rejected,
      idempotentReplay: true,
    });
    expect(await snapshot(capped.w.id)).toEqual({
      ...before,
      transactions: before.transactions + 1,
      events: before.events + 1,
    });
  });
  test("absence, PENDING and PENDING_REFERENCE remain pending without financial effect or replay reprocessing", async () => {
    const w = await wallet();
    const missing = randomUUID();
    const bodies = [input(w, "ROLLBACK", "1.00", missing)];
    for (const kind of ["BET", "WIN", "REFUND"] as const) {
      const body = input(
        w,
        kind,
        "2.00",
        kind === "REFUND" ? "unknown" : undefined,
      );
      const parsed = validateTransaction(body, randomUUID());
      await sql(
        `insert into wager_transactions(id,wallet_id,player_id,origin,kind,status,currency,money_minor_units,created_at,provider_id,external_transaction_id,idempotency_key,payload_hash,round_id,game_id,reference_external_transaction_id) values (?,?,?,'EXTERNAL',?,'PENDING','BRL',200,now(),?,?,?,?,?,?,?)`,
        [
          randomUUID(),
          w.id,
          w.playerId,
          kind,
          body.providerId,
          body.externalTransactionId,
          parsed.key,
          parsed.hash,
          body.roundId,
          body.gameId,
          body.referenceExternalTransactionId ?? null,
        ],
      );
      bodies.push(input(w, "ROLLBACK", "1.00", body.externalTransactionId));
    }
    for (const kind of ["WIN", "REFUND"]) {
      const body = input(w, kind, "2.00", randomUUID());
      expect(await useCases.submit(body, randomUUID())).toMatchObject({
        status: "PENDING_REFERENCE",
      });
      bodies.push(input(w, "ROLLBACK", "1.00", body.externalTransactionId));
    }
    for (const body of bodies) {
      const before = await snapshot(w.id);
      const key = randomUUID();
      const pending = await useCases.submit(body, key);
      expect(pending).toMatchObject({
        status: "PENDING_REFERENCE",
      });
      expect(BigInt(pending.balance.amount.replace(".", ""))).toBe(
        BigInt(before.balance),
      );
      expect(await snapshot(w.id)).toEqual({
        ...before,
        transactions: before.transactions + 1,
        events: before.events + 1,
      });
      expect(
        (await eventTypes(pending.transactionId)).map((e) => e.event_type),
      ).toEqual(["WagerTransactionPendingReference"]);
      if (body.referenceExternalTransactionId === missing)
        await useCases.submit(
          { ...input(w, "BET", "1.00"), externalTransactionId: missing },
          randomUUID(),
        );
      expect(await useCases.submit(body, key)).toEqual({
        ...pending,
        idempotentReplay: true,
      });
      expect(await eventTypes(pending.transactionId)).toHaveLength(1);
    }
  });
  test("context/self, kind, terminal state and amount retain precedence before prior compensation", async () => {
    const { w, reference, rollback } = await target();
    await useCases.submit(rollback, randomUUID());
    const self = input(w, "ROLLBACK", "1.00", "self");
    self.referenceExternalTransactionId = self.externalTransactionId;
    const cases: [ReturnType<typeof input>, string][] = [
      [self, "REFERENCE_CONTEXT_MISMATCH"],
      [
        {
          ...input(w, "ROLLBACK", "1.00", reference.externalTransactionId),
          roundId: "other",
        },
        "REFERENCE_CONTEXT_MISMATCH",
      ],
      [
        input(w, "ROLLBACK", "1.00", reference.externalTransactionId),
        "REFERENCE_AMOUNT_MISMATCH",
      ],
      [
        { ...rollback, externalTransactionId: randomUUID() },
        "REFERENCE_ALREADY_REVERSED",
      ],
    ];
    for (const kind of ["LOSS", "ROLLBACK"]) {
      const body =
        kind === "LOSS"
          ? input(w, kind, "0.00")
          : input(w, kind, "1.00", "missing");
      await useCases.submit(body, randomUUID());
      cases.push([
        input(w, "ROLLBACK", "1.00", body.externalTransactionId),
        "REFERENCE_KIND_MISMATCH",
      ]);
    }
    for (const kind of ["BET", "WIN", "REFUND"]) {
      const body =
        kind === "BET"
          ? input(w, kind, "200.00")
          : {
              ...input(w, kind, "1.00", reference.externalTransactionId),
              ...(kind === "WIN" ? { roundId: "other-round" } : {}),
            };
      expect(await useCases.submit(body, randomUUID())).toMatchObject({
        status: "REJECTED",
      });
      cases.push([
        {
          ...input(w, "ROLLBACK", "0.01", body.externalTransactionId),
          roundId: body.roundId,
        },
        "REFERENCE_NOT_PROCESSED",
      ]);
    }
    const other = await target();
    cases.push([
      input(w, "ROLLBACK", "1.00", other.reference.externalTransactionId),
      "REFERENCE_CONTEXT_MISMATCH",
    ]);
    for (const [body, code] of cases) {
      const before = await snapshot(w.id);
      expect(await useCases.submit(body, randomUUID())).toMatchObject({
        status: "REJECTED",
        failureCode: code,
      });
      expect(await snapshot(w.id)).toEqual({
        ...before,
        transactions: before.transactions + 1,
        events: before.events + 1,
      });
    }
    expect(
      await useCases.submit(
        {
          ...input(w, "ROLLBACK", "1.00", reference.externalTransactionId),
          providerId: "other",
        },
        randomUUID(),
      ),
    ).toMatchObject({ status: "PENDING_REFERENCE" });
  });
  test("every actual write rolls back in both directions, rejected and pending paths", async () => {
    for (const mode of ["credit", "debit", "rejected", "pending"] as const) {
      for (
        let stop = 1;
        stop <= (mode === "credit" || mode === "debit" ? 6 : 3);
        stop++
      ) {
        const { w, rollback } = await target(mode === "debit" ? "WIN" : "BET");
        const body =
          mode === "pending"
            ? { ...rollback, referenceExternalTransactionId: "missing" }
            : mode === "rejected"
              ? { ...rollback, money: { amount: "0.01", currency: "BRL" } }
              : rollback;
        const before = await snapshot(w.id);
        let writes = 0;
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
                        writes++;
                        expect(await snapshot(w.id)).toEqual(before);
                        if (writes === stop)
                          throw new Error("Injected rollback write failure");
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
        ).rejects.toThrow("Injected rollback write failure");
        expect(writes).toBe(stop);
        expect(await snapshot(w.id)).toEqual(before);
      }
    }
  });
  test("three processes serialize distinct rollback keys and mixed REFUND/ROLLBACK on the same BET", async () => {
    for (const mixed of [false, true]) {
      const { w, rollback } = await target(mixed ? "BET" : "WIN");
      const before = await snapshot(w.id);
      const workers = Array.from({ length: 3 }, (_, i) =>
        processWorker(db, [
          {
            body: {
              ...rollback,
              kind: mixed && i === 0 ? "REFUND" : "ROLLBACK",
              externalTransactionId: randomUUID(),
            },
            key: randomUUID(),
          },
        ]),
      );
      try {
        const pids = await Promise.all(workers.map((w) => w.ready));
        expect(new Set(pids).size).toBe(3);
        expect(pids.every((pid) => pid !== process.pid)).toBe(true);
        for (const worker of workers) worker.child.send("start");
        const results = (
          await Promise.all(workers.map((w) => w.result))
        ).flat();
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
        const after = await snapshot(w.id);
        expect(after.balance).toBe("10000");
        expect(after.version).toBe(before.version + 1);
        expect(after.entries).toBe(before.entries + 1);
        expect(after.transactions).toBe(before.transactions + 3);
        expect(after.events).toBe(before.events + 4);
      } finally {
        for (const worker of workers)
          if (worker.child.exitCode === null) worker.child.kill();
        await Promise.all(workers.map((w) => w.child.exited));
      }
    }
  });
  test("SQL rejects malformed rollback states and enforces the shared index; fallback rolls back before 503", async () => {
    const { w, rollback } = await target();
    const applied = await useCases.submit(rollback, randomUUID());
    for (const [assignment, constraint] of [
      ["money_minor_units=0", "transactions_money_range"],
      ["money_minor_units=100000001", "transactions_money_range"],
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
      [
        "status='REJECTED',failure_code='REVERSAL_INSUFFICIENT_FUNDS'",
        "transactions_processing_state",
      ],
    ])
      await expect(
        sql(`update wager_transactions set ${assignment} where id=?`, [
          applied.transactionId,
        ]),
      ).rejects.toMatchObject({ code: "23514", constraint });
    const body = { ...rollback, externalTransactionId: randomUUID() };
    const key = randomUUID();
    const before = await snapshot(w.id);
    let attempts = 0;
    const bypass: TransactionUnitOfWork = {
      execute: (operation) =>
        new MikroOrmTransactionUnitOfWork(db.orm.em).execute((repository) => {
          repository.hasProcessedReversal = async () => {
            attempts++;
            return false;
          };
          return operation(repository);
        }),
    };
    await expect(
      new TransactionUseCases(bypass).submit(body, key),
    ).rejects.toMatchObject({
      code: "TRANSACTION_RETRY_REQUIRED",
      statusCode: 503,
      cause: {
        code: "23505",
        constraint: "transactions_processed_reversal_unique",
      },
    });
    expect(attempts).toBe(1);
    expect(await snapshot(w.id)).toEqual(before);
    expect(
      await new TransactionRepository(db.observer.em.fork()).findByKey(key),
    ).toBeUndefined();
    const rejected = await useCases.submit(body, key);
    expect(rejected).toMatchObject({
      failureCode: "REFERENCE_ALREADY_REVERSED",
    });
    expect(await useCases.submit(body, key)).toEqual({
      ...rejected,
      idempotentReplay: true,
    });
    await expect(
      sql(
        "update wager_transactions set status='PROCESSED',failure_code=null where id=?",
        [rejected.transactionId],
      ),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "transactions_processed_reversal_unique",
    });
  });
  test("HTTP distinguishes applied/replay, pending/replay, reversal rejection/replay and invalid input", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.url;
    const app = await createApplication();
    try {
      await app.listen(0, "127.0.0.1");
      const base = await app.getUrl();
      const post = (body: unknown, key: string) =>
        fetch(`${base}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        });
      const { w, rollback, result } = await target("WIN");
      const key = randomUUID();
      const response = await post(rollback, key);
      expect(response.status).toBe(201);
      const applied = (await response.json()) as { transactionId: string };
      expect((await post(rollback, key)).status).toBe(200);
      for (const path of [
        `/wagering/transactions/${applied.transactionId}`,
        `/providers/${rollback.providerId}/wagering/transactions/${rollback.externalTransactionId}`,
      ]) {
        const audit = await fetch(base + path);
        expect(audit.status).toBe(200);
        expect(await audit.json()).toMatchObject({
          kind: "ROLLBACK",
          referenceTransactionId: result.transactionId,
        });
      }
      const poor = await target("WIN");
      await useCases.submit(input(poor.w, "BET", "125.37"), randomUUID());
      const rejectionKey = randomUUID();
      for (const replay of [false, true]) {
        const rejected = await post(poor.rollback, rejectionKey);
        expect(rejected.status).toBe(422);
        expect(await rejected.json()).toMatchObject({
          failureCode: "REVERSAL_INSUFFICIENT_FUNDS",
          idempotentReplay: replay,
        });
      }
      const pending = input(w, "ROLLBACK", "1.00", "missing-http");
      const pendingKey = randomUUID();
      expect((await post(pending, pendingKey)).status).toBe(202);
      expect((await post(pending, pendingKey)).status).toBe(202);
      const {
        referenceExternalTransactionId: _reference,
        ...withoutReference
      } = rollback;
      for (const body of [
        withoutReference,
        { ...rollback, referenceExternalTransactionId: null },
        { ...rollback, money: { amount: "0.00", currency: "BRL" } },
      ])
        expect((await post(body, randomUUID())).status).toBe(400);
      await snapshot(w.id);
      await snapshot(poor.w.id);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
