import { describe, expect, spyOn, test } from "bun:test";
import {
  LedgerDirection,
  LedgerEntryError,
  type LedgerEntryState,
  WalletLedgerEntry,
} from "../../src/modules/wagering/domain/ledger/wallet-ledger-entry.ts";
import { Money } from "../../src/modules/wagering/domain/money.ts";

const money = (amount: string, currency = "BRL") =>
  Money.from({ amount, currency });
const props = (direction = LedgerDirection.Credit): LedgerEntryState => ({
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "transaction-1",
  direction,
  money: money("25.00"),
  balanceBefore: money(
    direction === LedgerDirection.Credit ? "75.00" : "100.00",
  ),
  balanceAfter: money(
    direction === LedgerDirection.Credit ? "100.00" : "75.00",
  ),
  createdAt: new Date("2026-10-25T12:00:00Z"),
});

describe("WalletLedgerEntry", () => {
  test.each([LedgerDirection.Credit, LedgerDirection.Debit])(
    "creates a balanced immutable %s entry",
    (direction) => {
      const state = props(direction);
      const entry = WalletLedgerEntry.create(state);
      expect(entry.id).toBe(state.id);
      expect(entry.walletId).toBe(state.walletId);
      expect(entry.transactionId).toBe(state.transactionId);
      expect(entry.direction).toBe(direction);
      expect(entry.money.equals(state.money)).toBe(true);
      expect(entry.balanceBefore.equals(state.balanceBefore)).toBe(true);
      expect(entry.balanceAfter.equals(state.balanceAfter)).toBe(true);
      expect(entry.createdAt).toEqual(state.createdAt);
      expect(entry.isBalanced()).toBe(true);
    },
  );

  test("supports USD and the inclusive Money limit", () => {
    const entry = WalletLedgerEntry.create({
      ...props(),
      money: money("1000000.00", "USD"),
      balanceBefore: Money.zero("USD"),
      balanceAfter: money("1000000.00", "USD"),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.currency).toBe("USD");
  });

  test.each([LedgerDirection.Credit, LedgerDirection.Debit])(
    "rejects inconsistent arithmetic and zero for new %s entries",
    (direction) => {
      expect(() =>
        WalletLedgerEntry.create({
          ...props(direction),
          balanceAfter: money("99.99"),
        }),
      ).toThrow(LedgerEntryError);
      expect(() =>
        WalletLedgerEntry.create({
          ...props(direction),
          money: Money.zero("BRL"),
          balanceAfter: props(direction).balanceBefore,
        }),
      ).toThrow(LedgerEntryError);
    },
  );

  test.each(["money", "balanceBefore", "balanceAfter"] as const)(
    "rejects a negative value or currency mismatch in %s",
    (field) => {
      expect(() =>
        WalletLedgerEntry.create({
          ...props(),
          [field]: money("0.01").negate(),
        }),
      ).toThrow(LedgerEntryError);
      expect(() =>
        WalletLedgerEntry.create({
          ...props(),
          [field]: money("25.00", "USD"),
        }),
      ).toThrow(LedgerEntryError);
    },
  );

  test("rejects an impossible debit and credit overflow without clamping", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...props(LedgerDirection.Debit),
        balanceBefore: money("10.00"),
        balanceAfter: Money.zero("BRL"),
      }),
    ).toThrow(LedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...props(),
        balanceBefore: money("1000000.00"),
        balanceAfter: money("1000000.00"),
      }),
    ).toThrow(LedgerEntryError);
  });

  test("validates identifiers, direction and date", () => {
    for (const field of ["id", "walletId", "transactionId"] as const) {
      expect(() =>
        WalletLedgerEntry.create({ ...props(), [field]: " " }),
      ).toThrow(LedgerEntryError);
    }
    expect(() =>
      WalletLedgerEntry.create({ ...props(), createdAt: new Date("invalid") }),
    ).toThrow(LedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...props(),
        // @ts-expect-error External input can violate the direction contract.
        direction: "SIDEWAYS",
      }),
    ).toThrow(LedgerEntryError);
  });

  test("defends all fields and dates against mutation through props and getters", () => {
    const state = props();
    const originalDate = new Date(state.createdAt);
    const entry = WalletLedgerEntry.create(state);
    state.id = "changed";
    state.money = money("99.00");
    state.createdAt.setFullYear(2000);
    entry.createdAt.setFullYear(1990);
    for (const field of [
      "id",
      "walletId",
      "transactionId",
      "direction",
      "money",
      "balanceBefore",
      "balanceAfter",
      "createdAt",
    ] as const) {
      expect(Reflect.set(entry, field, "changed")).toBe(false);
    }
    expect(entry.id).toBe("entry-1");
    expect(entry.money.toJSON().amount).toBe("25.00");
    expect(entry.createdAt).toEqual(originalDate);
    expect(entry.isBalanced()).toBe(true);
  });

  test("rehydrates persisted fields without calling the creation factory", () => {
    const state = props(LedgerDirection.Debit);
    const creation = spyOn(WalletLedgerEntry, "create");
    try {
      const entry = WalletLedgerEntry.rehydrate(state);
      expect(creation).not.toHaveBeenCalled();
      expect(entry.id).toBe(state.id);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.equals(state.balanceBefore)).toBe(true);
      expect(entry.balanceAfter.equals(state.balanceAfter)).toBe(true);
      expect(entry.createdAt).toEqual(state.createdAt);
      expect(entry.isBalanced()).toBe(true);
      state.createdAt.setFullYear(2000);
      expect(entry.createdAt.toISOString()).toBe("2026-10-25T12:00:00.000Z");
    } finally {
      creation.mockRestore();
    }
  });
});
