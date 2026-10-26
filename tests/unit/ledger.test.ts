import { describe, expect, test } from "bun:test";
import {
  InvalidLedgerQueryError,
  type LedgerRepositoryPort,
  LedgerUseCases,
} from "../../src/modules/wagering/application/ledger.use-cases.ts";
import {
  InvalidWalletInputError,
  WalletNotFoundError,
} from "../../src/modules/wagering/application/wallet.errors.ts";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../src/modules/wagering/domain/ledger/wallet-ledger-entry.ts";
import { Money } from "../../src/modules/wagering/domain/money.ts";
import { Wallet } from "../../src/modules/wagering/domain/wallet/wallet.ts";

const walletId = "aaaaaaaa-0000-0000-0000-000000000001";
const entryId = "bbbbbbbb-0000-0000-0000-000000000001";
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const cursor = encode({ v: 1, walletId, entryId });
const wallet = Wallet.open({
  id: walletId,
  playerId: "player",
  initialBalance: Money.zero("BRL"),
  at: new Date(),
});
const entry = WalletLedgerEntry.create({
  id: entryId,
  walletId,
  transactionId: entryId,
  direction: LedgerDirection.Credit,
  money: Money.from({ amount: "0.01", currency: "BRL" }),
  balanceBefore: Money.zero("BRL"),
  balanceAfter: Money.from({ amount: "0.01", currency: "BRL" }),
  createdAt: new Date("2026-10-26T12:00:00Z"),
});
function setup() {
  const calls: unknown[][] = [];
  const repository: LedgerRepositoryPort = {
    findById: async (id) => {
      calls.push([id]);
      return wallet;
    },
    listLedgerEntries: async (...args) => {
      calls.push(args);
      return [];
    },
  };
  return {
    repository,
    calls,
    useCases: new LedgerUseCases({
      execute: (operation) => operation(repository),
    }),
  };
}

describe("Ledger pagination application contract", () => {
  test("validates query shape and strict decimal limit before persistence", async () => {
    const { calls, useCases } = setup();
    for (const query of [
      null,
      [],
      1,
      "",
      { extra: "x" },
      ...[
        undefined,
        null,
        [],
        {},
        50,
        1n,
        true,
        "",
        "0",
        "101",
        "01",
        "1.0",
        "1e1",
        "+1",
        "-1",
        " 1",
        "1 ",
        "1\n",
        "50\r\n",
        "100\n",
        "1;select",
      ].map((limit) => ({ limit })),
    ]) {
      await expect(useCases.list(walletId, query)).rejects.toBeInstanceOf(
        InvalidLedgerQueryError,
      );
    }
    expect(calls).toEqual([]);
    for (const limit of ["1", "50", "100"])
      await useCases.list(walletId, { limit });
    expect(
      calls.filter((call) => call.length === 3).map((call) => call[1]),
    ).toEqual([2, 51, 101]);
  });

  test("rejects noncanonical base64url, invalid UTF-8, versions, keys and cross-wallet cursors", async () => {
    const { calls, useCases } = setup();
    for (const value of [
      undefined,
      null,
      [],
      {},
      1,
      "",
      `${cursor}=`,
      ` ${cursor}`,
      `${cursor}\n`,
      "a",
      "+/",
      Buffer.from([0xff]).toString("base64url"),
      Buffer.from("{").toString("base64url"),
      ...[
        null,
        [],
        {},
        { v: 2, walletId, entryId },
        { v: "1", walletId, entryId },
        { v: 1, walletId, entryId, extra: true },
        { v: 1, walletId: entryId, entryId },
        { v: 1, walletId, entryId: "invalid" },
        { v: 1, walletId, entryId: `${entryId}\n` },
      ].map(encode),
    ]) {
      await expect(
        useCases.list(walletId, { cursor: value }),
      ).rejects.toBeInstanceOf(InvalidLedgerQueryError);
    }
    expect(calls).toEqual([]);
  });

  test("normalizes UUIDs and uses default limit plus one", async () => {
    const { calls, useCases } = setup();
    await useCases.list(walletId.toUpperCase(), {
      cursor: encode({
        v: 1,
        walletId: walletId.toUpperCase(),
        entryId: entryId.toUpperCase(),
      }),
    });
    expect(calls).toEqual([[walletId], [walletId, 51, entryId]]);
  });

  test("distinguishes invalid ID, absent wallet and absent anchor", async () => {
    const { repository, useCases } = setup();
    for (const id of [null, [], 1, "", "invalid", `${walletId}\n`])
      await expect(useCases.list(id, {})).rejects.toBeInstanceOf(
        InvalidWalletInputError,
      );
    repository.findById = async () => undefined;
    await expect(useCases.list(walletId, {})).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    repository.findById = async () => wallet;
    repository.listLedgerEntries = async () => undefined;
    await expect(useCases.list(walletId, { cursor })).rejects.toBeInstanceOf(
      InvalidLedgerQueryError,
    );
  });

  test("serializes exact money and emits cursor for the last returned entry only when another exists", async () => {
    const { repository, useCases } = setup();
    expect(await useCases.list(walletId, {})).toEqual({
      items: [],
      nextCursor: null,
    });
    repository.listLedgerEntries = async () => [entry, entry];
    const page = await useCases.list(walletId, { limit: "1" });
    expect(page.nextCursor).toBe(cursor);
    expect(page.items).toEqual([
      {
        id: entryId,
        walletId,
        transactionId: entryId,
        direction: LedgerDirection.Credit,
        money: { amount: "0.01", currency: "BRL" },
        balanceBefore: { amount: "0.00", currency: "BRL" },
        balanceAfter: { amount: "0.01", currency: "BRL" },
        createdAt: "2026-10-26T12:00:00.000Z",
      },
    ]);
    repository.listLedgerEntries = async () => [entry];
    expect(
      (await useCases.list(walletId, { limit: "1" })).nextCursor,
    ).toBeNull();
  });

  test("propagates database failure without interpreting it as a missing anchor", async () => {
    const { repository, useCases } = setup();
    const failure = new Error("database failed");
    repository.listLedgerEntries = async () => {
      throw failure;
    };
    await expect(useCases.list(walletId, { cursor })).rejects.toBe(failure);
  });
});
