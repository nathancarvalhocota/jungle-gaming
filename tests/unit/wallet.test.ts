import { describe, expect, spyOn, test } from "bun:test";
import {
  LedgerDirection,
  LedgerEntryError,
  WalletLedgerEntry,
} from "../../src/modules/wagering/domain/ledger/wallet-ledger-entry.ts";
import { Money, MoneyError } from "../../src/modules/wagering/domain/money.ts";
import {
  Wallet,
  WalletError,
  type WalletMovementProps,
  type WalletState,
} from "../../src/modules/wagering/domain/wallet/wallet.ts";

const money = (amount: string, currency = "BRL") =>
  Money.from({ amount, currency });
const openedAt = () => new Date("2026-10-25T12:00:00Z");
const movedAt = () => new Date("2026-10-25T12:01:00Z");
const open = (amount = "100.00", currency = "BRL") =>
  Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: money(amount, currency),
    at: openedAt(),
  });
const movement = (amount = "25.00", currency = "BRL"): WalletMovementProps => ({
  entryId: "entry-1",
  transactionId: "transaction-1",
  money: money(amount, currency),
  at: movedAt(),
});
const snapshot = (wallet: Wallet) => ({
  balance: wallet.balance.toJSON(),
  version: wallet.version,
  createdAt: wallet.createdAt,
  updatedAt: wallet.updatedAt,
});
const state = (): WalletState => ({
  id: "wallet-1",
  playerId: "player-1",
  currency: "BRL",
  balance: money("75.00"),
  version: 7,
  createdAt: openedAt(),
  updatedAt: movedAt(),
});

describe("Wallet", () => {
  test.each(["BRL", "USD"])(
    "opens zero or positive balance in %s with version 1",
    (currency) => {
      for (const amount of ["0.00", "100.00", "1000000.00"]) {
        const wallet = open(amount, currency);
        expect(wallet.id).toBe("wallet-1");
        expect(wallet.playerId).toBe("player-1");
        expect(wallet.currency).toBe(currency);
        expect(wallet.balance.toJSON()).toEqual({ amount, currency });
        expect(wallet.version).toBe(1);
        expect(wallet.createdAt).toEqual(openedAt());
        expect(wallet.updatedAt).toEqual(openedAt());
      }
      expect(() =>
        Wallet.open({
          id: "wallet",
          playerId: "player",
          initialBalance: money("0.01", currency).negate(),
          at: openedAt(),
        }),
      ).toThrow(WalletError);
    },
  );

  test.each(["BRL", "USD"])(
    "debits and credits %s returning the corresponding balanced entries",
    (currency) => {
      const wallet = open("100.00", currency);
      const debit = wallet.debit(movement("25.00", currency));
      expect(wallet.balance.toJSON().amount).toBe("75.00");
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(movedAt());
      expect(wallet.createdAt).toEqual(openedAt());
      expect(debit.id).toBe("entry-1");
      expect(debit.walletId).toBe(wallet.id);
      expect(debit.transactionId).toBe("transaction-1");
      expect(debit.direction).toBe(LedgerDirection.Debit);
      expect(debit.money.toJSON()).toEqual({ amount: "25.00", currency });
      expect(debit.balanceBefore.toJSON().amount).toBe("100.00");
      expect(debit.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(debit.createdAt).toEqual(movedAt());
      expect(debit.isBalanced()).toBe(true);
      const later = new Date("2026-10-25T12:02:00Z");
      const credit = wallet.credit({
        ...movement("0.10", currency),
        entryId: "entry-2",
        transactionId: "transaction-2",
        at: later,
      });
      expect(wallet.balance.toJSON()).toEqual({ amount: "75.10", currency });
      expect(wallet.version).toBe(3);
      expect(wallet.updatedAt).toEqual(later);
      expect(credit.direction).toBe(LedgerDirection.Credit);
      expect(credit.transactionId).toBe("transaction-2");
      expect(credit.balanceBefore.equals(debit.balanceAfter)).toBe(true);
      expect(credit.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(credit.isBalanced()).toBe(true);
      expect(debit.balanceAfter.toJSON().amount).toBe("75.00");
    },
  );

  test("can debit the full balance and credit up to the inclusive Money limit", () => {
    const wallet = open();
    const debit = wallet.debit(movement("100.00"));
    expect(wallet.balance.isZero()).toBe(true);
    expect(debit.isBalanced()).toBe(true);
    expect(wallet.version).toBe(2);
    const credit = wallet.credit(movement("1000000.00"));
    expect(wallet.balance.toJSON().amount).toBe("1000000.00");
    expect(credit.isBalanced()).toBe(true);
    expect(wallet.version).toBe(3);
    const before = snapshot(wallet);
    expect(() => wallet.credit(movement("0.01"))).toThrow(MoneyError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test("insufficient balance leaves all wallet state unchanged", () => {
    const wallet = open();
    const before = snapshot(wallet);
    expect(() => wallet.debit(movement("100.01"))).toThrow(WalletError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each(["debit", "credit"] as const)(
    "%s rejects zero, negative and foreign currency without creating entries",
    (method) => {
      const wallet = open();
      const before = snapshot(wallet);
      const creation = spyOn(WalletLedgerEntry, "create");
      try {
        for (const value of [
          Money.zero("BRL"),
          money("0.01").negate(),
          money("25.00", "USD"),
        ]) {
          expect(() => wallet[method]({ ...movement(), money: value })).toThrow(
            WalletError,
          );
          expect(snapshot(wallet)).toEqual(before);
        }
        expect(creation).not.toHaveBeenCalled();
      } finally {
        creation.mockRestore();
      }
    },
  );

  test.each(["debit", "credit"] as const)(
    "%s builds and validates ledger before changing state",
    (method) => {
      const wallet = open();
      const before = snapshot(wallet);
      for (const invalid of [
        { ...movement(), entryId: "" },
        { ...movement(), transactionId: "" },
        { ...movement(), at: new Date("invalid") },
      ]) {
        expect(() => wallet[method](invalid)).toThrow(LedgerEntryError);
        expect(snapshot(wallet)).toEqual(before);
      }
      const creation = spyOn(WalletLedgerEntry, "create").mockImplementation(
        () => {
          expect(snapshot(wallet)).toEqual(before);
          throw new LedgerEntryError("Injected ledger construction failure");
        },
      );
      try {
        expect(() => wallet[method](movement())).toThrow(LedgerEntryError);
        expect(snapshot(wallet)).toEqual(before);
      } finally {
        creation.mockRestore();
      }
    },
  );

  test("defends identity, opening and movement dates and caller-owned props", () => {
    const at = openedAt();
    const props = {
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("100.00"),
      at,
    };
    const wallet = Wallet.open(props);
    props.id = "changed";
    props.initialBalance = money("99.00");
    at.setFullYear(2000);
    wallet.createdAt.setFullYear(1990);
    wallet.updatedAt.setFullYear(1990);
    expect(wallet.createdAt).toEqual(openedAt());
    expect(wallet.updatedAt).toEqual(openedAt());
    const move = movement();
    const entry = wallet.credit(move);
    move.at.setFullYear(2000);
    wallet.updatedAt.setFullYear(1990);
    entry.createdAt.setFullYear(1980);
    expect(wallet.updatedAt).toEqual(movedAt());
    expect(entry.createdAt).toEqual(movedAt());
    for (const field of [
      "id",
      "playerId",
      "currency",
      "balance",
      "version",
      "createdAt",
      "updatedAt",
    ] as const) {
      expect(Reflect.set(wallet, field, "changed")).toBe(false);
    }
    expect(wallet.id).toBe("wallet-1");
    expect(wallet.balance.toJSON().amount).toBe("125.00");
  });

  test("rehydrates state without replaying movements or incrementing version", () => {
    const persisted = state();
    const creation = spyOn(WalletLedgerEntry, "create");
    try {
      const wallet = Wallet.rehydrate(persisted);
      expect(creation).not.toHaveBeenCalled();
      expect(wallet.balance.equals(persisted.balance)).toBe(true);
      expect(wallet.version).toBe(7);
      expect(wallet.createdAt).toEqual(persisted.createdAt);
      expect(wallet.updatedAt).toEqual(persisted.updatedAt);
      persisted.createdAt.setFullYear(2000);
      persisted.updatedAt.setFullYear(2000);
      persisted.balance = money("99.00");
      persisted.version = 99;
      expect(wallet.createdAt).toEqual(openedAt());
      expect(wallet.updatedAt).toEqual(movedAt());
      wallet.debit(movement("25.00"));
      expect(wallet.balance.toJSON().amount).toBe("50.00");
      expect(wallet.version).toBe(8);
    } finally {
      creation.mockRestore();
    }
  });

  test("checks structural integrity on rehydration", () => {
    for (const version of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => Wallet.rehydrate({ ...state(), version })).toThrow(
        WalletError,
      );
    }
    for (const invalid of [
      { ...state(), id: "" },
      { ...state(), playerId: " " },
      { ...state(), balance: money("0.01").negate() },
      { ...state(), currency: "USD" },
      { ...state(), createdAt: new Date("invalid") },
      { ...state(), updatedAt: new Date("invalid") },
    ]) {
      expect(() => Wallet.rehydrate(invalid)).toThrow(WalletError);
    }
  });

  test("version overflow fails without a partial movement", () => {
    const wallet = Wallet.rehydrate({
      ...state(),
      version: Number.MAX_SAFE_INTEGER,
    });
    const before = snapshot(wallet);
    expect(() => wallet.credit(movement())).toThrow(WalletError);
    expect(snapshot(wallet)).toEqual(before);
  });
});
