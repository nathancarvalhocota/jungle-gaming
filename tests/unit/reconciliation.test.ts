import { describe, expect, spyOn, test } from "bun:test";
import {
  type ReconciliationObservation,
  type ReconciliationReader,
  ReconciliationUseCases,
} from "../../src/modules/wagering/application/reconciliation.use-cases.ts";
import {
  InvalidWalletInputError,
  WalletNotFoundError,
} from "../../src/modules/wagering/application/wallet.errors.ts";
import { ProcessReconciliationObserver } from "../../src/modules/wagering/infrastructure/reconciliation.observer.ts";

const walletId = "aaaaaaaa-0000-0000-0000-000000000001";
const correlationId = "bbbbbbbb-0000-0000-0000-000000000001";
function setup(stored = 0n, calculated = 0n, entries = 0n) {
  const reads: string[] = [];
  const observations: ReconciliationObservation[] = [];
  const reader: ReconciliationReader = {
    read: async (id) => {
      reads.push(id);
      return {
        storedMinorUnits: stored,
        calculatedMinorUnits: calculated,
        currency: "BRL",
        checkedEntries: entries,
      };
    },
  };
  const useCases = new ReconciliationUseCases(reader, {
    record: (observation) => observations.push(observation),
  });
  return { reader, reads, observations, useCases };
}

describe("Reconciliation application contract", () => {
  test("observer explicitly logs metadata even if its caller passes additional financial fields", () => {
    const observer = new ProcessReconciliationObserver();
    const logs: unknown[][] = [];
    const log = spyOn(console, "info").mockImplementation((...args) => {
      logs.push(args);
    });
    const observation = {
      walletId,
      correlationId,
      result: "mismatch" as const,
      checkedEntries: 2,
      storedBalance: { amount: "25.37", currency: "BRL" },
      credentials: "must-never-be-logged",
    };
    try {
      observer.record(observation);
    } finally {
      log.mockRestore();
    }
    expect(logs).toHaveLength(1);
    expect(JSON.parse(String(logs[0]?.[0]))).toEqual({
      event: "wallet_reconciliation_mismatch",
      walletId,
      correlationId,
      result: "mismatch",
      checkedEntries: 2,
    });
    expect(observer.metrics()).toContain(
      'reconciliation_checks_total{result="mismatch"} 1',
    );
    expect(new ProcessReconciliationObserver().metrics()).toContain(
      'reconciliation_checks_total{result="mismatch"} 0',
    );
  });
  test("validates and normalizes wallet IDs before reading", async () => {
    const { useCases, reads } = setup();
    for (const id of [
      undefined,
      null,
      [],
      {},
      1,
      "",
      "invalid",
      `${walletId}\n`,
    ])
      await expect(
        useCases.reconcile(id, correlationId),
      ).rejects.toBeInstanceOf(InvalidWalletInputError);
    expect(reads).toEqual([]);
    await useCases.reconcile(walletId.toUpperCase(), correlationId);
    expect(reads).toEqual([walletId]);
  });

  test("distinguishes absence from propagated infrastructure failures without counting either", async () => {
    const { reader, useCases, observations } = setup();
    reader.read = async () => undefined;
    await expect(
      useCases.reconcile(walletId, correlationId),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    const failure = new Error("database unavailable");
    reader.read = async () => {
      throw failure;
    };
    await expect(useCases.reconcile(walletId, correlationId)).rejects.toBe(
      failure,
    );
    expect(observations).toEqual([]);
  });

  test("formats zero, exact cents, signed differences and arbitrarily large diagnostic sums", async () => {
    for (const [
      stored,
      calculated,
      storedAmount,
      calculatedAmount,
      difference,
    ] of [
      [0n, 0n, "0.00", "0.00", "0.00"],
      [2537n, 2536n, "25.37", "25.36", "0.01"],
      [0n, 1n, "0.00", "0.01", "-0.01"],
      [100000000n, -1n, "1000000.00", "-0.01", "1000000.01"],
      [
        0n,
        900719925474099301n,
        "0.00",
        "9007199254740993.01",
        "-9007199254740993.01",
      ],
    ] as const) {
      const { useCases, observations } = setup(stored, calculated, 42n);
      expect(await useCases.reconcile(walletId, correlationId)).toEqual({
        walletId,
        storedBalance: { amount: storedAmount, currency: "BRL" },
        calculatedBalance: { amount: calculatedAmount, currency: "BRL" },
        difference: { amount: difference, currency: "BRL" },
        consistent: stored === calculated,
        checkedEntries: 42,
      });
      expect(observations).toEqual([
        {
          walletId,
          correlationId,
          result: stored === calculated ? "consistent" : "mismatch",
          checkedEntries: 42,
        },
      ]);
    }
  });

  test("converts only safe nonnegative entry counts to number", async () => {
    for (const entries of [-1n, 9007199254740992n]) {
      const { useCases, observations } = setup(0n, 0n, entries);
      await expect(useCases.reconcile(walletId, correlationId)).rejects.toThrow(
        "safe integer",
      );
      expect(observations).toEqual([]);
    }
    const { useCases } = setup(0n, 0n, 9007199254740991n);
    expect(
      (await useCases.reconcile(walletId, correlationId)).checkedEntries,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});
