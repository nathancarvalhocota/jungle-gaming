import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApplication } from "../../src/main.ts";
import { TransactionUseCases } from "../../src/modules/wagering/application/transaction.use-cases.ts";
import { validateBet } from "../../src/modules/wagering/application/transaction-input.ts";
import type {
  TransactionRepositoryPort,
  TransactionUnitOfWork,
} from "../../src/modules/wagering/application/transaction-ports.ts";
import { WalletUseCases } from "../../src/modules/wagering/application/wallet.use-cases.ts";
import { WagerTransactionSchema } from "../../src/modules/wagering/infrastructure/persistence/opening.schema.ts";
import {
  MikroOrmTransactionUnitOfWork,
  TransactionRepository,
} from "../../src/modules/wagering/infrastructure/persistence/transaction.repository.ts";
import { MikroOrmWalletUnitOfWork } from "../../src/modules/wagering/infrastructure/persistence/wallet.unit-of-work.ts";
import {
  assertBetDatabase,
  createBetDatabase,
} from "../support/bet-database.ts";

describe("BET persistente, idempotente e concorrente", () => {
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
  async function wallet(amount = "100.00") {
    return new WalletUseCases(new MikroOrmWalletUnitOfWork(db.orm.em)).create({
      playerId: randomUUID(),
      initialBalance: { amount, currency: "BRL" },
    });
  }
  function bet(w: { id: string; playerId: string }, amount = "25.00") {
    return {
      providerId: "provider",
      externalTransactionId: randomUUID(),
      playerId: w.playerId,
      walletId: w.id,
      roundId: "round",
      gameId: "game",
      kind: "BET",
      money: { amount, currency: "BRL" },
    };
  }
  const sql = <T extends object[]>(query: string, params: unknown[] = []) =>
    db.observer.em.getConnection().execute<T>(query, params);
  async function assertState(
    id: string,
    balance: string,
    debits: number,
    bets: number,
    betEvents: number,
  ) {
    const [row] = await sql<
      {
        balance: string;
        reconstructed: string;
        debits: number;
        bets: number;
        events: number;
      }[]
    >(
      `select w.balance_minor_units::text as balance,
      coalesce((select sum(case when direction='CREDIT' then money_minor_units else -money_minor_units end) from wallet_ledger_entries where wallet_id=w.id),0)::text as reconstructed,
      (select count(*)::int from wallet_ledger_entries where wallet_id=w.id and direction='DEBIT') as debits,
      (select count(*)::int from wager_transactions where wallet_id=w.id and kind='BET') as bets,
      (select count(*)::int from outbox_messages o join wager_transactions t on (o.aggregate_id=t.id or o.payload->'data'->>'transactionId'=t.id::text) where t.wallet_id=w.id and t.kind='BET') as events
      from wallets w where w.id=?`,
      [id],
    );
    expect(row).toEqual({
      balance,
      reconstructed: balance,
      debits,
      bets,
      events: betEvents,
    });
  }
  test("migration BET reverte sem perder abertura e reaplica antes de aceitar operações externas", async () => {
    const w = await wallet();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    expect(await db.orm.migrator.getExecuted()).toHaveLength(2);
    await assertState(w.id, "10000", 0, 0, 0);
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.up();
    expect(await db.orm.migrator.getExecuted()).toHaveLength(5);
  });
  test("50 reenvios simultâneos debitam uma vez e replay guarda saldo original após outra movimentação", async () => {
    const w = await wallet();
    const input = bet(w);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCases.submit(input, key)),
    );
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.balance.amount === "75.00")).toBe(true);
    await assertState(w.id, "7500", 1, 1, 2);
    await useCases.submit(bet(w, "10.00"), randomUUID());
    const replay = await useCases.submit(
      { ...input, walletId: input.walletId.toUpperCase() },
      key,
    );
    expect(replay.balance.amount).toBe("75.00");
    expect(replay.idempotentReplay).toBe(true);
    const audit = await useCases.get(replay.transactionId);
    expect(
      await useCases.getExternal(input.providerId, input.externalTransactionId),
    ).toEqual(audit);
    expect(audit).toMatchObject({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      money: input.money,
      balance: { amount: "75.00", currency: "BRL" },
    });
    expect(audit).not.toHaveProperty("idempotencyKey");
    expect(audit).not.toHaveProperty("payloadHash");
    await assertState(w.id, "6500", 2, 2, 4);
  });
  test("duas apostas80 disputam100: uma processada, uma rejeitada auditável sem novo débito no replay", async () => {
    const w = await wallet();
    const inputs = [bet(w, "80.00"), bet(w, "80.00")];
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(
      inputs.map((input, i) => useCases.submit(input, keys[i])),
    );
    expect(results.map((r) => String(r.status)).sort()).toEqual([
      "PROCESSED",
      "REJECTED",
    ]);
    const index = results.findIndex((r) => r.status === "REJECTED");
    expect(results[index]).toMatchObject({
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "20.00" },
    });
    expect(await useCases.submit(inputs[index], keys[index])).toMatchObject({
      ...results[index],
      idempotentReplay: true,
    });
    await assertState(w.id, "2000", 1, 2, 3);
    const restored = await new TransactionRepository(
      db.observer.em.fork(),
    ).findTransaction(results[index]?.transactionId ?? "");
    expect(restored?.isTerminal()).toBe(true);
    expect(String(restored?.failureCode)).toBe("INSUFFICIENT_FUNDS");
  });
  test("chave global diverge entre wallets e identidade externa com outra chave conflita sem efeitos", async () => {
    const one = await wallet();
    const two = await wallet();
    const key = randomUUID();
    const first = bet(one);
    const second = bet(two);
    const race = await Promise.allSettled([
      useCases.submit(first, key),
      useCases.submit(second, key),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = race.find((r) => r.status === "rejected");
    expect(
      failure?.status === "rejected" ? failure.reason.code : undefined,
    ).toBe("IDEMPOTENCY_CONFLICT");
    const winner = race[0]?.status === "fulfilled" ? first : second;
    const loser = winner === first ? second : first;
    await expect(
      useCases.submit({ ...loser, walletId: randomUUID() }, key),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(useCases.submit(winner, randomUUID())).rejects.toMatchObject({
      code: "EXTERNAL_TRANSACTION_CONFLICT",
    });
    await assertState(winner.walletId, "7500", 1, 1, 2);
    await assertState(loser.walletId, "10000", 0, 0, 0);
    const a = await wallet();
    const b = await wallet();
    const external = randomUUID();
    const identityRace = await Promise.allSettled([
      useCases.submit(
        { ...bet(a), externalTransactionId: external },
        randomUUID(),
      ),
      useCases.submit(
        { ...bet(b), externalTransactionId: external },
        randomUUID(),
      ),
    ]);
    expect(identityRace.filter((r) => r.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(
      identityRace
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason.code),
    ).toEqual(["EXTERNAL_TRANSACTION_CONFLICT"]);
    const aWon = identityRace[0]?.status === "fulfilled";
    await assertState(
      a.id,
      aWon ? "7500" : "10000",
      aWon ? 1 : 0,
      aWon ? 1 : 0,
      aWon ? 2 : 0,
    );
    await assertState(
      b.id,
      aWon ? "10000" : "7500",
      aWon ? 0 : 1,
      aWon ? 0 : 1,
      aWon ? 0 : 2,
    );
  });
  test("falha após cada escrita real desfaz claim, resultado, saldo, ledger e outbox", async () => {
    for (let stop = 1; stop <= 6; stop++) {
      const w = await wallet();
      const input = bet(w);
      let writes = 0;
      const uow: TransactionUnitOfWork = {
        execute: (operation) =>
          new MikroOrmTransactionUnitOfWork(db.orm.em).execute((repository) => {
            const wrapped = new Proxy(repository, {
              get(target, property) {
                const member = Reflect.get(target, property);
                if (typeof member !== "function") return member;
                return async (...args: unknown[]) => {
                  const value = await member.apply(target, args);
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
                    await assertState(w.id, "10000", 0, 0, 0);
                    if (writes === stop)
                      throw new Error("Injected failure after database write");
                  }
                  return value;
                };
              },
            }) as TransactionRepositoryPort;
            return operation(wrapped);
          }),
      };
      await expect(
        new TransactionUseCases(uow).submit(input, randomUUID()),
      ).rejects.toThrow("Injected failure");
      expect(writes).toBe(stop);
      await assertState(w.id, "10000", 0, 0, 0);
    }
  });
  test("wallets distintas avançam enquanto uma disputa lock PostgreSQL real; timeout desfaz tentativa e permite reenvio", async () => {
    const blocked = await wallet();
    const free = await wallet();
    const input = bet(blocked);
    const key = randomUUID();
    const locker = db.observer.em.fork();
    await locker.begin();
    try {
      await locker.execute("select id from wallets where id=? for update", [
        blocked.id,
      ]);
      const pending = useCases.submit(input, key);
      const waiting = await waitForWalletLock();
      expect(waiting).toBe(true);
      const freeResult = await useCases.submit(bet(free), randomUUID());
      expect(String(freeResult.status)).toBe("PROCESSED");
      await expect(pending).rejects.toMatchObject({
        code: "TRANSACTION_RETRY_REQUIRED",
        statusCode: 503,
      });
      await assertState(blocked.id, "10000", 0, 0, 0);
    } finally {
      await locker.rollback();
    }
    expect(await useCases.submit(input, key)).toMatchObject({
      status: "PROCESSED",
      idempotentReplay: false,
    });
    await assertState(blocked.id, "7500", 1, 1, 2);
    await assertState(free.id, "7500", 1, 1, 2);
  }, 15000);
  async function waitForWalletLock(): Promise<boolean> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const [row] = await sql<{ waiting: boolean }[]>(
        "select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%wallets%' and pid <> pg_backend_pid()) as waiting",
      );
      if (row?.waiting) return true;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return false;
  }
  test("três processos reais disputam 50 duplicatas e saldo80/100 após barreira explícita", async () => {
    const duplicateWallet = await wallet();
    const raceWallet = await wallet();
    const input = bet(duplicateWallet);
    const key = randomUUID();
    const jobs = Array.from(
      { length: 3 },
      () => [] as { body: unknown; key: string }[],
    );
    for (let index = 0; index < 50; index++)
      jobs[index % 3]?.push({ body: input, key });
    jobs[0]?.push({ body: bet(raceWallet, "80.00"), key: randomUUID() });
    jobs[1]?.push({ body: bet(raceWallet, "80.00"), key: randomUUID() });
    const workers = jobs.map((batch) => processWorker(batch));
    try {
      const pids = await Promise.all(workers.map((w) => w.ready));
      expect(new Set(pids).size).toBe(3);
      expect(pids.every((pid) => pid !== process.pid)).toBe(true);
      for (const worker of workers) worker.child.send("start");
      const all = (await Promise.all(workers.map((w) => w.result))).flat();
      expect(all.filter((r) => "error" in r)).toHaveLength(0);
      const duplicates = all.filter(
        (r) => "result" in r && r.result.balance.amount === "75.00",
      );
      expect(duplicates).toHaveLength(50);
      expect(
        duplicates.filter((r) => "result" in r && !r.result.idempotentReplay),
      ).toHaveLength(1);
      expect(await Promise.all(workers.map((w) => w.child.exited))).toEqual([
        0, 0, 0,
      ]);
      await assertState(duplicateWallet.id, "7500", 1, 1, 2);
      await assertState(raceWallet.id, "2000", 1, 2, 3);
    } finally {
      for (const worker of workers)
        if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all(workers.map((worker) => worker.child.exited));
    }
  });
  function processWorker(jobs: { body: unknown; key: string }[]) {
    let readyResolve: (pid: number) => void;
    let resultResolve: (value: WorkerResult[]) => void;
    let readyReject: (error: Error) => void;
    let resultReject: (error: Error) => void;
    let readyReceived = false;
    let resultReceived = false;
    const ready = new Promise<number>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const result = new Promise<WorkerResult[]>((resolve, reject) => {
      resultResolve = resolve;
      resultReject = reject;
    });
    const child = Bun.spawn(
      [process.execPath, "run", "tests/support/bet-process.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: db.url,
          BET_DATABASE_URL: db.url,
          BET_EXPECTED_DATABASE: db.name,
          BET_JOBS: JSON.stringify(jobs),
        },
        stdout: "ignore",
        stderr: "inherit",
        ipc(message: unknown) {
          if (!message || typeof message !== "object") return;
          if (
            "type" in message &&
            message.type === "ready" &&
            "pid" in message &&
            typeof message.pid === "number"
          ) {
            readyReceived = true;
            readyResolve(message.pid);
          }
          if (
            "type" in message &&
            message.type === "result" &&
            "results" in message &&
            Array.isArray(message.results)
          ) {
            resultReceived = true;
            resultResolve(message.results);
          }
        },
      },
    );
    void child.exited.then((code) => {
      if (code !== 0 || !readyReceived || !resultReceived) {
        const error = new Error(`BET worker failed (${code})`);
        if (!readyReceived) readyReject(error);
        if (!resultReceived) resultReject(error);
      }
    });
    return { child, ready, result };
  }
  type WorkerResult =
    | { error: string }
    | { result: { balance: { amount: string }; idempotentReplay: boolean } };
  test("schema reforça identidade, estados e unicidades; down com BET recusa sem apagar dados", async () => {
    const w = await wallet();
    const input = bet(w);
    const key = randomUUID();
    const result = await useCases.submit(input, key);
    const row = await db.observer.em
      .fork()
      .findOneOrFail(WagerTransactionSchema, { id: result.transactionId });
    const query = `insert into wager_transactions(id,wallet_id,player_id,origin,kind,status,currency,money_minor_units,created_at,provider_id,external_transaction_id,idempotency_key,payload_hash,round_id,game_id) values (?,?,?,?,?,'PENDING','BRL',?,now(),?,?,?,?,?,?)`;
    const values = () => [
      randomUUID(),
      w.id,
      w.playerId,
      "EXTERNAL",
      "BET",
      "2500",
      "other",
      randomUUID(),
      randomUUID(),
      validateBet(input, key).hash,
      "round",
      "game",
    ];
    for (const [index, value] of [
      [3, "INTERNAL"],
      [4, "OPENING"],
      [5, "0"],
      [5, "-1"],
      [5, "100000001"],
      [6, null],
      [9, "invalid"],
      [10, null],
      [11, null],
    ] as const) {
      const invalid = values();
      invalid[index] = value as never;
      await expect(sql(query, invalid)).rejects.toMatchObject({
        code: "23514",
        constraint:
          index === 5
            ? "transactions_money_range"
            : "transactions_origin_identity",
      });
    }
    const sameKey = values();
    sameKey[8] = key;
    await expect(sql(query, sameKey)).rejects.toMatchObject({
      code: "23505",
      constraint: "transactions_idempotency_key_unique",
    });
    const sameExternal = values();
    sameExternal[6] = input.providerId;
    sameExternal[7] = input.externalTransactionId;
    await expect(sql(query, sameExternal)).rejects.toMatchObject({
      code: "23505",
      constraint: "transactions_external_identity_unique",
    });
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.down();
    await assertBetDatabase(db.orm, db.url, db.name);
    await expect(db.orm.migrator.down()).rejects.toMatchObject({
      code: "23514",
      constraint: "transactions_internal_opening",
    });
    expect(await db.orm.migrator.getExecuted()).toHaveLength(3);
    await assertBetDatabase(db.orm, db.url, db.name);
    await db.orm.migrator.up();
    expect(
      (
        await db.observer.em
          .fork()
          .findOneOrFail(WagerTransactionSchema, { id: row.id })
      ).payloadHash,
    ).toBe(row.payloadHash);
    await assertState(w.id, "7500", 1, 1, 2);
  });
  test("HTTP distingue validação, conflito, rejeição e replay e permite consultas auditáveis", async () => {
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = db.url;
    const app = await createApplication();
    try {
      await app.listen(0, "127.0.0.1");
      const base = await app.getUrl();
      const w = await wallet();
      const input = bet(w);
      const key = randomUUID();
      const post = (body: unknown, header: string | null = key) =>
        fetch(`${base}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(header === null ? {} : { "Idempotency-Key": header }),
          },
          body: JSON.stringify(body),
        });
      expect((await post(input, "")).status).toBe(400);
      const missingHeader = await post(input, null);
      expect(missingHeader.status).toBe(400);
      expect(await missingHeader.json()).toMatchObject({
        code: "INVALID_TRANSACTION_INPUT",
      });
      expect(
        (await post({ ...input, money: { amount: "0.00", currency: "BRL" } }))
          .status,
      ).toBe(400);
      expect((await post({ ...input, extra: true })).status).toBe(400);
      expect((await post({ ...input, kind: "OPENING" })).status).toBe(400);
      const created = await post(input);
      expect(created.status).toBe(201);
      const original = (await created.json()) as { transactionId: string };
      expect((await post(input)).status).toBe(200);
      expect((await post({ ...input, walletId: randomUUID() })).status).toBe(
        409,
      );
      expect((await post(input, randomUUID())).status).toBe(409);
      const rejectInput = bet(w, "80.00");
      const rejectKey = randomUUID();
      for (const replay of [false, true]) {
        const response = await post(rejectInput, rejectKey);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
          failureCode: "INSUFFICIENT_FUNDS",
          idempotentReplay: replay,
          balance: { amount: "75.00" },
        });
      }
      for (const path of [
        `/wagering/transactions/${original.transactionId}`,
        `/providers/${input.providerId}/wagering/transactions/${input.externalTransactionId}`,
      ]) {
        const response = await fetch(base + path);
        expect(response.status).toBe(200);
        const audit = await response.json();
        expect(audit).not.toHaveProperty("payloadHash");
        expect(audit).not.toHaveProperty("idempotencyKey");
      }
      expect(
        (await fetch(`${base}/wagering/transactions/${randomUUID()}`)).status,
      ).toBe(404);
      expect(
        (await fetch(`${base}/wagering/transactions/not-uuid`)).status,
      ).toBe(400);
      await assertState(w.id, "7500", 1, 2, 3);
    } finally {
      await app.close();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
  });
  test("três processos compartilham idempotência WIN/LOSS/pendência e disputam teto sem crédito duplicado", async () => {
    const w = await wallet("999999.00");
    const win = { ...bet(w, "0.50"), kind: "WIN" };
    const loss = { ...bet(w, "0.00"), kind: "LOSS" };
    const pending = {
      ...bet(w, "0.01"),
      kind: "WIN",
      referenceExternalTransactionId: "missing-three-processes",
    };
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    const jobs = Array.from(
      { length: 3 },
      () => [] as { body: unknown; key: string }[],
    );
    for (let i = 0; i < 50; i++) {
      for (const [index, body] of [win, loss, pending].entries())
        jobs[i % 3]?.push({ body, key: keys[index] ?? "" });
    }
    const workers = jobs.map((batch) => processWorker(batch));
    try {
      expect(
        new Set(await Promise.all(workers.map((worker) => worker.ready))).size,
      ).toBe(3);
      for (const worker of workers) worker.child.send("start");
      const results = (
        await Promise.all(workers.map((worker) => worker.result))
      ).flat();
      expect(results).toHaveLength(150);
      expect(results.filter((result) => "error" in result)).toHaveLength(0);
      expect(
        results.filter(
          (result) => "result" in result && !result.result.idempotentReplay,
        ),
      ).toHaveLength(3);
      expect(
        await Promise.all(workers.map((worker) => worker.child.exited)),
      ).toEqual([0, 0, 0]);
    } finally {
      for (const worker of workers)
        if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all(workers.map((worker) => worker.child.exited));
    }
    const capJobs = Array.from({ length: 3 }, () => [
      { body: { ...bet(w, "0.50"), kind: "WIN" }, key: randomUUID() },
    ]);
    const capWorkers = capJobs.map((batch) => processWorker(batch));
    try {
      expect(
        new Set(await Promise.all(capWorkers.map((worker) => worker.ready)))
          .size,
      ).toBe(3);
      for (const worker of capWorkers) worker.child.send("start");
      const results = (
        await Promise.all(capWorkers.map((worker) => worker.result))
      ).flat();
      expect(results.filter((result) => "error" in result)).toHaveLength(0);
      expect(
        await Promise.all(capWorkers.map((worker) => worker.child.exited)),
      ).toEqual([0, 0, 0]);
    } finally {
      for (const worker of capWorkers)
        if (worker.child.exitCode === null) worker.child.kill();
      await Promise.all(capWorkers.map((worker) => worker.child.exited));
    }
    const [row] = await sql<
      {
        balance: string;
        reconstructed: string;
        version: number;
        wins: number;
        rejected: number;
        pending: number;
        loss: number;
        entries: number;
        events: number;
      }[]
    >(
      `select balance_minor_units::text as balance, version,
      (select sum(case when direction='CREDIT' then money_minor_units else -money_minor_units end)::text from wallet_ledger_entries where wallet_id=w.id) as reconstructed,
      (select count(*)::int from wager_transactions where wallet_id=w.id and kind='WIN' and status='PROCESSED') as wins,
      (select count(*)::int from wager_transactions where wallet_id=w.id and status='REJECTED' and failure_code='BALANCE_LIMIT_EXCEEDED') as rejected,
      (select count(*)::int from wager_transactions where wallet_id=w.id and status='PENDING_REFERENCE') as pending,
      (select count(*)::int from wager_transactions where wallet_id=w.id and kind='LOSS') as loss,
      (select count(*)::int from wallet_ledger_entries where wallet_id=w.id) as entries,
      (select count(*)::int from outbox_messages o join wager_transactions t on o.payload->'data'->>'transactionId'=t.id::text where t.wallet_id=w.id) as events
      from wallets w where id=?`,
      [w.id],
    );
    expect(row).toEqual({
      balance: "100000000",
      reconstructed: "100000000",
      version: 3,
      wins: 2,
      rejected: 2,
      pending: 1,
      loss: 1,
      entries: 3,
      events: 10,
    });
  });
});
