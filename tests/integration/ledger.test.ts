import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApplication } from "../../src/main.ts";
import {
  InvalidLedgerQueryError,
  LedgerUseCases,
} from "../../src/modules/wagering/application/ledger.use-cases.ts";
import { TransactionUseCases } from "../../src/modules/wagering/application/transaction.use-cases.ts";
import { WalletNotFoundError } from "../../src/modules/wagering/application/wallet.errors.ts";
import { WalletUseCases } from "../../src/modules/wagering/application/wallet.use-cases.ts";
import { MikroOrmTransactionUnitOfWork } from "../../src/modules/wagering/infrastructure/persistence/transaction.repository.ts";
import {
  MikroOrmLedgerUnitOfWork,
  MikroOrmWalletUnitOfWork,
} from "../../src/modules/wagering/infrastructure/persistence/wallet.unit-of-work.ts";
import {
  assertBetDatabase,
  createBetDatabase,
} from "../support/bet-database.ts";

describe("Ledger keyset pagination in PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof createBetDatabase>>;
  let ledger: LedgerUseCases;
  let wallets: WalletUseCases;
  beforeAll(async () => {
    db = await createBetDatabase();
    ledger = new LedgerUseCases(new MikroOrmLedgerUnitOfWork(db.orm.em));
    wallets = new WalletUseCases(new MikroOrmWalletUnitOfWork(db.orm.em));
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
  const cursor = (walletId: string, entryId: string) =>
    Buffer.from(JSON.stringify({ v: 1, walletId, entryId })).toString(
      "base64url",
    );
  const id = (suffix: number) =>
    `abcdefab-0000-0000-0000-${String(suffix).padStart(12, "0")}`;

  // SQL fixtures preserve transaction identity, exact arithmetic and wallet/ledger balance.
  // Timestamps are inserted directly so PostgreSQL microseconds never pass through Date.
  async function credit(
    w: { id: string; playerId: string },
    entryId: string,
    at: string,
  ) {
    await db.orm.em.fork().transactional(async (em) => {
      const transactionId = randomUUID();
      await em.execute("select id from wallets where id = ? for update", [
        w.id,
      ]);
      await em.execute(
        `insert into wager_transactions
        (id,wallet_id,player_id,origin,kind,status,currency,money_minor_units,balance_minor_units,created_at,processed_at,provider_id,external_transaction_id,idempotency_key,payload_hash,round_id,game_id)
        select ?,id,player_id,'EXTERNAL','WIN','PROCESSED',currency,1,balance_minor_units+1,?::timestamptz,?::timestamptz,'fixture',?,?,?,'round','game' from wallets where id = ?`,
        [
          transactionId,
          at,
          at,
          transactionId,
          transactionId,
          "a".repeat(64),
          w.id,
        ],
      );
      await em.execute(
        `insert into wallet_ledger_entries
        (id,wallet_id,transaction_id,direction,currency,money_minor_units,balance_before_minor_units,balance_after_minor_units,created_at)
        select ?,id,?,'CREDIT',currency,1,balance_minor_units,balance_minor_units+1,?::timestamptz from wallets where id = ?`,
        [entryId, transactionId, at, w.id],
      );
      await em.execute(
        "update wallets set balance_minor_units = balance_minor_units+1, version = version+1, updated_at = ?::timestamptz where id = ?",
        [at, w.id],
      );
    });
  }
  async function snapshot(walletId: string) {
    return sql(
      `select w.balance_minor_units::text balance,w.version,w.updated_at,
      (select coalesce(sum(case direction when 'CREDIT' then money_minor_units else -money_minor_units end),0)::text from wallet_ledger_entries where wallet_id=w.id) reconstructed,
      (select jsonb_agg(to_jsonb(e) order by id) from wallet_ledger_entries e where wallet_id=w.id) ledger,
      (select count(*)::int from wager_transactions where wallet_id=w.id) transactions,
      (select count(*)::int from outbox_messages where aggregate_id=w.id) events
      from wallets w where id=?`,
      [walletId],
    );
  }

  test("index down/up is incremental, reversible and preserves data and immutability", async () => {
    const w = await wallet("25.37");
    const before = await snapshot(w.id);
    const index = () =>
      sql<{ indexdef: string }[]>(
        "select indexdef from pg_indexes where indexname='ledger_wallet_created_id_idx'",
      );
    expect((await index())[0]?.indexdef).toContain(
      "(wallet_id, created_at, id)",
    );
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    expect(await index()).toEqual([]);
    expect(await snapshot(w.id)).toEqual(before);
    await expect(
      sql(
        "update wallet_ledger_entries set money_minor_units=money_minor_units where wallet_id=?",
        [w.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.up();
    expect((await index())[0]?.indexdef).toContain(
      "(wallet_id, created_at, id)",
    );
    expect(await snapshot(w.id)).toEqual(before);
    expect((await ledger.list(w.id, {})).items[0]?.money).toEqual({
      amount: "25.37",
      currency: "BRL",
    });
  });

  test("paginates deterministic timestamp ties, exact boundaries and wallet isolation without mutations", async () => {
    const w = await wallet();
    const other = await wallet("1.00");
    for (const suffix of [1, 4, 2, 5, 3])
      await credit(w, id(suffix), "2026-10-26T12:00:00.123456Z");
    const before = await snapshot(w.id);
    const first = await ledger.list(w.id.toUpperCase(), { limit: "2" });
    expect(first.items.map((item) => item.id)).toEqual([id(5), id(4)]);
    expect(first.nextCursor).toBe(cursor(w.id, id(4)));
    const second = await ledger.list(w.id, {
      limit: "2",
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual([id(3), id(2)]);
    const third = await ledger.list(w.id, {
      limit: "2",
      cursor: second.nextCursor,
    });
    expect(third.items.map((item) => item.id)).toEqual([id(1)]);
    expect(third.nextCursor).toBeNull();
    const boundary = await ledger.list(w.id, {
      limit: "1",
      cursor: cursor(w.id, id(2)),
    });
    expect(boundary.items.map((item) => item.id)).toEqual([id(1)]);
    expect(boundary.nextCursor).toBeNull();
    expect(await ledger.list(w.id, { cursor: cursor(w.id, id(1)) })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(first.items.every((item) => item.walletId === w.id)).toBe(true);
    expect((await ledger.list(other.id, {})).items).toHaveLength(1);
    await expect(
      ledger.list(other.id, { cursor: first.nextCursor }),
    ).rejects.toBeInstanceOf(InvalidLedgerQueryError);
    await expect(
      ledger.list(other.id, { cursor: cursor(other.id, id(4)) }),
    ).rejects.toBeInstanceOf(InvalidLedgerQueryError);
    await expect(
      ledger.list(w.id, { cursor: cursor(w.id, randomUUID()) }),
    ).rejects.toBeInstanceOf(InvalidLedgerQueryError);
    expect(await snapshot(w.id)).toEqual(before);
    expect(before[0]).toMatchObject({ balance: "5", reconstructed: "5" });
  });

  test("compares the real PostgreSQL microsecond anchor rather than a rounded JS timestamp", async () => {
    const w = await wallet();
    // Reverse UUID order across different microseconds detects timestamp rounding in either direction.
    await credit(w, id(13), "2026-10-26T12:00:00.123001Z");
    await credit(w, id(12), "2026-10-26T12:00:00.123002Z");
    await credit(w, id(11), "2026-10-26T12:00:00.123003Z");
    const all: string[] = [];
    let next: string | null = null;
    do {
      const page = await ledger.list(w.id, {
        limit: "1",
        ...(next ? { cursor: next } : {}),
      });
      all.push(...page.items.map((item) => item.id));
      next = page.nextCursor;
    } while (next);
    expect(all).toEqual([id(11), id(12), id(13)]);
    const before = await snapshot(w.id);
    expect(before[0]).toMatchObject({ balance: "3", reconstructed: "3" });
  });

  test("returns empty wallets and missing-wallet errors distinctly", async () => {
    const w = await wallet();
    expect(await ledger.list(w.id, {})).toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(ledger.list(randomUUID(), {})).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    const maximum = await wallet("1000000.00");
    expect((await ledger.list(maximum.id, {})).items[0]).toMatchObject({
      money: { amount: "1000000.00", currency: "BRL" },
      balanceBefore: { amount: "0.00", currency: "BRL" },
      balanceAfter: { amount: "1000000.00", currency: "BRL" },
    });
  });

  test("applies default fifty and maximum one hundred limits against persisted entries", async () => {
    const w = await wallet();
    for (let suffix = 1000; suffix <= 1100; suffix++) {
      await credit(w, id(suffix), "2026-10-26T12:00:00.123456Z");
    }
    const defaultPage = await ledger.list(w.id, {});
    expect(defaultPage.items).toHaveLength(50);
    expect(defaultPage.nextCursor).toBe(cursor(w.id, id(1051)));
    const maximumPage = await ledger.list(w.id, { limit: "100" });
    expect(maximumPage.items).toHaveLength(100);
    expect(maximumPage.nextCursor).toBe(cursor(w.id, id(1001)));
    const last = await ledger.list(w.id, {
      limit: "100",
      cursor: maximumPage.nextCursor,
    });
    expect(last.items.map((item) => item.id)).toEqual([id(1000)]);
    expect(last.nextCursor).toBeNull();
    expect((await snapshot(w.id))[0]).toMatchObject({
      balance: "101",
      reconstructed: "101",
    });
  });

  test("continues below the anchor while newer entries require restarting and late old commits remain visible", async () => {
    const w = await wallet();
    for (const suffix of [21, 22, 23])
      await credit(w, id(suffix), `2026-10-26T12:00:0${suffix - 20}Z`);
    const page = await ledger.list(w.id, { limit: "1" });
    await Promise.all([
      credit(w, id(24), "2026-10-26T12:00:04Z"),
      credit(w, id(25), "2026-10-26T12:00:02.500000Z"),
    ]);
    const continuation = await ledger.list(w.id, { cursor: page.nextCursor });
    expect(continuation.items.map((item) => item.id)).toEqual([
      id(25),
      id(22),
      id(21),
    ]);
    expect((await ledger.list(w.id, {})).items.map((item) => item.id)).toEqual([
      id(24),
      id(23),
      id(25),
      id(22),
      id(21),
    ]);
    expect((await snapshot(w.id))[0]).toMatchObject({
      balance: "5",
      reconstructed: "5",
    });
  });

  test("HTTP exposes exact opening and debit money, pagination and stable error codes", async () => {
    const w = await wallet("25.37");
    await new TransactionUseCases(
      new MikroOrmTransactionUnitOfWork(db.orm.em),
    ).submit(
      {
        providerId: "http-ledger",
        externalTransactionId: randomUUID(),
        walletId: w.id,
        playerId: w.playerId,
        roundId: "round",
        gameId: "game",
        kind: "BET",
        money: { amount: "0.01", currency: "BRL" },
      },
      randomUUID(),
    );
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.url;
    const app = await createApplication();
    try {
      await app.listen(0, "127.0.0.1");
      const base = `${await app.getUrl()}/wallets`;
      const response = await fetch(`${base}/${w.id}/ledger?limit=1`);
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        items: {
          money: { amount: string };
          direction: string;
          balanceAfter: { amount: string };
        }[];
        nextCursor: string;
      };
      expect(result.items).toMatchObject([
        {
          direction: "DEBIT",
          money: { amount: "0.01" },
          balanceAfter: { amount: "25.36" },
        },
      ]);
      const next = await fetch(
        `${base}/${w.id}/ledger?cursor=${result.nextCursor}&limit=1`,
      );
      expect(next.status).toBe(200);
      expect(await next.json()).toMatchObject({
        items: [{ direction: "CREDIT", money: { amount: "25.37" } }],
        nextCursor: null,
      });
      for (const [path, code, status] of [
        [`${w.id}/ledger?limit=1&limit=2`, "INVALID_LEDGER_QUERY", 400],
        [`${w.id}/ledger?limit=50%0A`, "INVALID_LEDGER_QUERY", 400],
        [`${w.id}/ledger?cursor=bad`, "INVALID_LEDGER_QUERY", 400],
        [`${w.id}/ledger?other=x`, "INVALID_LEDGER_QUERY", 400],
        ["invalid/ledger", "INVALID_WALLET_INPUT", 400],
        [`${randomUUID()}/ledger`, "WALLET_NOT_FOUND", 404],
      ] as const) {
        const invalid = await fetch(`${base}/${path}`);
        expect(invalid.status).toBe(status);
        expect(await invalid.json()).toMatchObject({ code });
      }
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
    expect((await snapshot(w.id))[0]).toMatchObject({
      balance: "2536",
      reconstructed: "2536",
    });
  });
});
