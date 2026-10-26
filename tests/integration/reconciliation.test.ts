import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApplication } from "../../src/main.ts";
import { ReconciliationUseCases } from "../../src/modules/wagering/application/reconciliation.use-cases.ts";
import { TransactionUseCases } from "../../src/modules/wagering/application/transaction.use-cases.ts";
import { WalletNotFoundError } from "../../src/modules/wagering/application/wallet.errors.ts";
import { WalletUseCases } from "../../src/modules/wagering/application/wallet.use-cases.ts";
import { MikroOrmReconciliationReader } from "../../src/modules/wagering/infrastructure/persistence/reconciliation.reader.ts";
import { MikroOrmTransactionUnitOfWork } from "../../src/modules/wagering/infrastructure/persistence/transaction.repository.ts";
import { MikroOrmWalletUnitOfWork } from "../../src/modules/wagering/infrastructure/persistence/wallet.unit-of-work.ts";
import { ProcessReconciliationObserver } from "../../src/modules/wagering/infrastructure/reconciliation.observer.ts";
import {
  assertBetDatabase,
  createBetDatabase,
} from "../support/bet-database.ts";

describe("Read-only wallet reconciliation in PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof createBetDatabase>>;
  let wallets: WalletUseCases;
  let transactions: TransactionUseCases;
  let reconciliation: ReconciliationUseCases;
  beforeAll(async () => {
    db = await createBetDatabase();
    wallets = new WalletUseCases(new MikroOrmWalletUnitOfWork(db.orm.em));
    transactions = new TransactionUseCases(
      new MikroOrmTransactionUnitOfWork(db.orm.em),
    );
    reconciliation = new ReconciliationUseCases(
      new MikroOrmReconciliationReader(db.orm.em),
      new ProcessReconciliationObserver(),
    );
  });
  afterAll(async () => {
    await db?.close();
  });
  const sql = <T extends object[]>(query: string, params: unknown[] = []) =>
    db.observer.em.getConnection().execute<T>(query, params);
  const wallet = (amount = "0.00") =>
    wallets.create({
      playerId: randomUUID(),
      initialBalance: { amount, currency: "BRL" },
    });
  const reconcile = (walletId: string) =>
    reconciliation.reconcile(walletId, randomUUID());
  const submit = (
    w: { id: string; playerId: string },
    kind: string,
    amount: string,
    referenceExternalTransactionId?: string,
  ) => {
    const externalTransactionId = randomUUID();
    return transactions
      .submit(
        {
          providerId: "reconciliation",
          externalTransactionId,
          walletId: w.id,
          playerId: w.playerId,
          roundId: "round",
          gameId: "game",
          kind,
          money: { amount, currency: "BRL" },
          ...(referenceExternalTransactionId
            ? { referenceExternalTransactionId }
            : {}),
        },
        randomUUID(),
      )
      .then((result) => ({ ...result, externalTransactionId }));
  };
  const snapshot = () =>
    sql(`select
    (select jsonb_agg(to_jsonb(w) order by id) from wallets w) wallets,
    (select jsonb_agg(to_jsonb(t) order by id) from wager_transactions t) transactions,
    (select jsonb_agg(to_jsonb(e) order by id) from wallet_ledger_entries e) ledger,
    (select jsonb_agg(to_jsonb(o) order by id) from outbox_messages o) outbox`);

  test("reconstructs zero, opening cents and inclusive maximum without any writes", async () => {
    for (const amount of ["0.00", "0.01", "25.37", "1000000.00"]) {
      const w = await wallet(amount);
      const before = await snapshot();
      expect(await reconcile(w.id)).toEqual({
        walletId: w.id,
        storedBalance: { amount, currency: "BRL" },
        calculatedBalance: { amount, currency: "BRL" },
        difference: { amount: "0.00", currency: "BRL" },
        consistent: true,
        checkedEntries: amount === "0.00" ? 0 : 1,
      });
      expect(await snapshot()).toEqual(before);
    }
    await expect(reconcile(randomUUID())).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });

  test("reconstructs actual OPENING/BET/WIN/LOSS/REFUND/ROLLBACK history and ignores nonmoving results", async () => {
    const w = await wallet("25.37");
    const bet = await submit(w, "BET", "1.01");
    await submit(w, "WIN", "0.03");
    await submit(w, "LOSS", "0.00");
    const refund = await submit(w, "REFUND", "1.01", bet.externalTransactionId);
    await submit(w, "ROLLBACK", "1.01", refund.externalTransactionId);
    await submit(w, "BET", "100.00");
    await submit(w, "WIN", "0.01", randomUUID());
    const before = await snapshot();
    expect(await reconcile(w.id)).toMatchObject({
      storedBalance: { amount: "24.39" },
      calculatedBalance: { amount: "24.39" },
      difference: { amount: "0.00" },
      consistent: true,
      checkedEntries: 5,
    });
    expect(await snapshot()).toEqual(before);
  });

  // Each fixture keeps all SQL checks/FKs and immutable entries intact, but deliberately
  // violates the cross-entry history that the schema does not guarantee for manual SQL.
  async function diagnosticEntry(
    w: { id: string; playerId: string },
    direction: "CREDIT" | "DEBIT",
    amount: string,
  ) {
    await assertBetDatabase(db.orm, db.url, db.name);
    const transactionId = randomUUID();
    await db.orm.em.fork().transactional(async (em) => {
      await em.execute(
        `insert into wager_transactions
        (id,wallet_id,player_id,origin,kind,status,currency,money_minor_units,balance_minor_units,created_at,processed_at,provider_id,external_transaction_id,idempotency_key,payload_hash,round_id,game_id)
        values (?, ?, ?, 'EXTERNAL', ?, 'PROCESSED', 'BRL', ?::bigint, ?::bigint, now(), now(), 'diagnostic-fixture', ?, ?, ?, 'round', 'game')`,
        [
          transactionId,
          w.id,
          w.playerId,
          direction === "CREDIT" ? "WIN" : "BET",
          amount,
          direction === "CREDIT" ? amount : "0",
          transactionId,
          transactionId,
          "a".repeat(64),
        ],
      );
      await em.execute(
        `insert into wallet_ledger_entries
        (id,wallet_id,transaction_id,direction,currency,money_minor_units,balance_before_minor_units,balance_after_minor_units,created_at)
        values (?, ?, ?, ?, 'BRL', ?::bigint, ?::bigint, ?::bigint, now())`,
        [
          randomUUID(),
          w.id,
          transactionId,
          direction,
          amount,
          direction === "CREDIT" ? "0" : amount,
          direction === "CREDIT" ? amount : "0",
        ],
      );
    });
  }

  test("reports negative reconstruction and differences beyond Money's ceiling without repairing corrupted history", async () => {
    const w = await wallet();
    await diagnosticEntry(w, "DEBIT", "1");
    await sql("update wallets set balance_minor_units=100000000 where id=?", [
      w.id,
    ]);
    const before = await snapshot();
    const logs: unknown[][] = [];
    const log = spyOn(console, "info").mockImplementation((...args) => {
      logs.push(args);
    });
    try {
      expect(await reconcile(w.id)).toMatchObject({
        storedBalance: { amount: "1000000.00" },
        calculatedBalance: { amount: "-0.01" },
        difference: { amount: "1000000.01" },
        consistent: false,
        checkedEntries: 1,
      });
    } finally {
      log.mockRestore();
    }
    expect(logs).toHaveLength(1);
    expect(JSON.parse(String(logs[0]?.[0]))).toEqual({
      event: "wallet_reconciliation_mismatch",
      walletId: w.id,
      correlationId: expect.any(String),
      result: "mismatch",
      checkedEntries: 1,
    });
    expect(await snapshot()).toEqual(before);
    const high = await wallet();
    await diagnosticEntry(high, "CREDIT", "100000000");
    await diagnosticEntry(high, "CREDIT", "1");
    const highBefore = await snapshot();
    const quiet = spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await reconcile(high.id)).toMatchObject({
        calculatedBalance: { amount: "1000000.01" },
        difference: { amount: "-1000000.01" },
        consistent: false,
        checkedEntries: 2,
      });
    } finally {
      quiet.mockRestore();
    }
    expect(await snapshot()).toEqual(highBefore);
  });

  test("holds one statement snapshot while a real financial commit happens during the SELECT", async () => {
    const w = await wallet("25.37");
    const key = 8142708;
    const readerEm = db.orm.em.fork();
    const actualExecute = readerEm.execute.bind(readerEm);
    const fork = spyOn(readerEm, "fork").mockReturnValue(readerEm);
    const execute = spyOn(readerEm, "execute").mockImplementation(
      (query, params) => {
        if (typeof query !== "string")
          throw new Error("Expected reconciliation SQL");
        return actualExecute(
          `with reconciliation_barrier as materialized (select pg_advisory_xact_lock(${key})) ${query.replace("from wallets w", "from wallets w cross join reconciliation_barrier")}`,
          params,
        );
      },
    );
    let unlock!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const holder = db.observer.em.fork().transactional(async (em) => {
      await em.execute("select pg_advisory_xact_lock(?)", [key]);
      locked();
      await release;
    });
    let pending: ReturnType<ReconciliationUseCases["reconcile"]> | undefined;
    try {
      await held;
      pending = new ReconciliationUseCases(
        new MikroOrmReconciliationReader(readerEm),
        new ProcessReconciliationObserver(),
      ).reconcile(w.id, randomUUID());
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await sql<{ waiting: boolean }[]>(
          `select exists(select 1 from pg_stat_activity where datname=current_database() and query like 'with reconciliation_barrier%' and wait_event='advisory') waiting`,
        );
        if (rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await submit(w, "BET", "0.01");
      // The writer committed while the read was demonstrably blocked inside its command.
      expect(
        (
          await sql<{ balance: string }[]>(
            "select balance_minor_units::text balance from wallets where id=?",
            [w.id],
          )
        )[0]?.balance,
      ).toBe("2536");
      unlock();
      await holder;
      expect(await pending).toMatchObject({
        storedBalance: { amount: "25.37" },
        calculatedBalance: { amount: "25.37" },
        consistent: true,
        checkedEntries: 1,
      });
      expect(await reconcile(w.id)).toMatchObject({
        storedBalance: { amount: "25.36" },
        calculatedBalance: { amount: "25.36" },
        consistent: true,
        checkedEntries: 2,
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      unlock();
      await holder;
      await pending;
      execute.mockRestore();
      fork.mockRestore();
    }
  });

  test("propagates real SQL failure without fabricating absence or mismatch", async () => {
    const em = db.orm.em.fork();
    const actualExecute = em.execute.bind(em);
    const fork = spyOn(em, "fork").mockReturnValue(em);
    const execute = spyOn(em, "execute").mockImplementation(() =>
      actualExecute("select reconciliation_missing_column from wallets"),
    );
    const observer = { record: () => {} };
    const record = spyOn(observer, "record");
    try {
      await expect(
        new ReconciliationUseCases(
          new MikroOrmReconciliationReader(em),
          observer,
        ).reconcile(randomUUID(), randomUUID()),
      ).rejects.toMatchObject({ code: "42703" });
      expect(record).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
      fork.mockRestore();
    }
  });

  test("HTTP returns diagnostics, logs metadata only and exposes actual low-cardinality counters", async () => {
    const w = await wallet("25.37");
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.url;
    const app = await createApplication();
    const logs: unknown[][] = [];
    let log: ReturnType<typeof spyOn<typeof console, "info">> | undefined;
    try {
      await app.listen(0, "127.0.0.1");
      const base = await app.getUrl();
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      expect(await metrics.text()).toContain(
        'reconciliation_checks_total{result="consistent"} 0',
      );
      const response = await fetch(`${base}/wallets/${w.id}/reconciliation`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        walletId: w.id,
        storedBalance: { amount: "25.37", currency: "BRL" },
        calculatedBalance: { amount: "25.37", currency: "BRL" },
        difference: { amount: "0.00", currency: "BRL" },
        consistent: true,
        checkedEntries: 1,
      });
      await sql("update wallets set balance_minor_units=2538 where id=?", [
        w.id,
      ]);
      const before = await snapshot();
      log = spyOn(console, "info").mockImplementation((...args) => {
        logs.push(args);
      });
      const mismatch = await fetch(`${base}/wallets/${w.id}/reconciliation`, {
        method: "POST",
        headers: { "X-Correlation-Id": "untrusted" },
      });
      expect(mismatch.status).toBe(200);
      expect(await mismatch.json()).toMatchObject({
        calculatedBalance: { amount: "25.37" },
        storedBalance: { amount: "25.38" },
        difference: { amount: "0.01" },
        consistent: false,
        checkedEntries: 1,
      });
      expect(await snapshot()).toEqual(before);
      expect(logs).toHaveLength(1);
      const entry = JSON.parse(String(logs[0]?.[0]));
      expect(entry).toEqual({
        event: "wallet_reconciliation_mismatch",
        correlationId: expect.stringMatching(
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        ),
        walletId: w.id,
        result: "mismatch",
        checkedEntries: 1,
      });
      for (const [id, status, code] of [
        ["invalid", 400, "INVALID_WALLET_INPUT"],
        [randomUUID(), 404, "WALLET_NOT_FOUND"],
      ] as const) {
        const invalid = await fetch(`${base}/wallets/${id}/reconciliation`, {
          method: "POST",
        });
        expect(invalid.status).toBe(status);
        expect(await invalid.json()).toMatchObject({ code });
      }
      const useCases = app.get(ReconciliationUseCases);
      for (const [failure, status, code] of [
        [
          Object.assign(new Error("private database details"), {
            code: "08006",
          }),
          503,
          "DATABASE_UNAVAILABLE",
        ],
        [
          Object.assign(new Error("private SQL details"), { code: "42703" }),
          500,
          "INTERNAL_ERROR",
        ],
      ] as const) {
        const failing = spyOn(useCases, "reconcile").mockRejectedValue(failure);
        try {
          const unavailable = await fetch(
            `${base}/wallets/${w.id}/reconciliation`,
            { method: "POST" },
          );
          expect(unavailable.status).toBe(status);
          const body = await unavailable.json();
          expect(body).toMatchObject({ statusCode: status, code });
          expect(JSON.stringify(body)).not.toContain("private");
        } finally {
          failing.mockRestore();
        }
      }
      const text = await (await fetch(`${base}/metrics`)).text();
      expect(text).toBe(
        '# HELP reconciliation_checks_total Completed wallet reconciliation checks in this process.\n# TYPE reconciliation_checks_total counter\nreconciliation_checks_total{result="consistent"} 1\nreconciliation_checks_total{result="mismatch"} 1\n',
      );
      expect(text).not.toContain(w.id);
      expect(text).not.toContain(entry.correlationId);
    } finally {
      log?.mockRestore();
      await app.close();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
