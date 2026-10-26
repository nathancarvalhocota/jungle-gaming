import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  validateBet,
} from "../../src/modules/wagering/application/transaction-input.ts";
import { WagerTransactionProcessed } from "../../src/modules/wagering/domain/events/opening-events.ts";
import { WagerTransactionRejected } from "../../src/modules/wagering/domain/events/transaction-rejected.ts";
import { Money } from "../../src/modules/wagering/domain/money.ts";
import {
  FailureCode,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/transactions/wager-transaction.ts";

const body = () => ({
  providerId: "provider",
  externalTransactionId: "external",
  playerId: "player",
  walletId: randomUUID(),
  roundId: "round",
  gameId: "game",
  kind: "BET",
  money: { amount: "1.00", currency: "BRL" },
});
describe("BET domain and canonical input", () => {
  test("rehydration validates every external field and copies only the declared identity", () => {
    const parsed = validateBet(body(), "key");
    const external = {
      providerId: parsed.input.providerId,
      externalTransactionId: parsed.input.externalTransactionId,
      idempotencyKey: parsed.key,
      payloadHash: parsed.hash,
      roundId: parsed.input.roundId,
      gameId: parsed.input.gameId,
    };
    const state: WagerTransactionState = {
      id: randomUUID(),
      walletId: parsed.input.walletId,
      playerId: parsed.input.playerId,
      money: parsed.money,
      origin: "EXTERNAL",
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Rejected,
      external,
      failureCode: FailureCode.InsufficientFunds,
      balance: Money.zero("BRL"),
      createdAt: new Date(),
      processedAt: new Date(),
    };
    const restored = WagerTransaction.rehydrate(state);
    expect(restored.balance?.toJSON().amount).toBe("0.00");
    for (const field of Object.keys(external)) {
      for (const invalid of [undefined, null, 42, " "]) {
        const candidate = { ...external, [field]: invalid };
        expect(() =>
          WagerTransaction.rehydrate({ ...state, external: candidate }),
        ).toThrow();
      }
    }
    const injected = { ...external, id: "injected", markProcessed: "injected" };
    const safe = WagerTransaction.rehydrate({ ...state, external: injected });
    expect(safe.id).toBe(state.id);
    expect(typeof safe.markProcessed).toBe("function");
    expect(() =>
      WagerTransaction.rehydrate({
        ...state,
        external: { ...external, payloadHash: `${external.payloadHash}\n` },
      }),
    ).toThrow();
  });
  test("canonical hash ignores order and UUID case and preserves business strings", () => {
    const input = body();
    const first = validateBet(input, "key");
    const reordered = {
      ...input,
      money: { currency: "BRL", amount: "1.00" },
      walletId: input.walletId.toUpperCase(),
    };
    expect(validateBet(reordered, "other-key").hash).toBe(first.hash);
    for (const field of [
      "providerId",
      "externalTransactionId",
      "playerId",
      "roundId",
      "gameId",
    ])
      expect(
        validateBet({ ...input, [field]: `${field}-other` }, "key").hash,
      ).not.toBe(first.hash);
    expect(
      validateBet(
        { ...input, money: { amount: "1.01", currency: "BRL" } },
        "key",
      ).hash,
    ).not.toBe(first.hash);
    expect(
      validateBet({ ...input, walletId: randomUUID() }, "key").hash,
    ).not.toBe(first.hash);
    expect(
      validateBet({ ...input, providerId: " provider" }, "key").hash,
    ).not.toBe(first.hash);
    expect(canonicalJson({ z: { b: 2, a: 1 }, a: 0 })).toBe(
      '{"a":0,"z":{"a":1,"b":2}}',
    );
  });
  test("rejects zero, nulls, unknowns, references and unavailable kinds", () => {
    for (const input of [
      null,
      { ...body(), gameId: null },
      { ...body(), gameId: undefined },
      { ...body(), extra: true },
      { ...body(), referenceExternalTransactionId: "ref" },
      { ...body(), money: { amount: "0.00", currency: "BRL" } },
      { ...body(), money: { amount: 1, currency: "BRL" } },
      { ...body(), kind: "OPENING" },
      { ...body(), kind: "WIN" },
    ])
      expect(() => validateBet(input, "key")).toThrow();
    for (const key of [undefined, "", " ", ["one", "two"]])
      expect(() => validateBet(body(), key)).toThrow();
  });
  test("terminal rejection is immutable and cannot create a processed event", () => {
    const parsed = validateBet(body(), "key");
    const at = new Date();
    const transaction = WagerTransaction.createBet({
      ...parsed.input,
      id: randomUUID(),
      money: parsed.money,
      idempotencyKey: parsed.key,
      payloadHash: parsed.hash,
      at,
    });
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.matchesPayload(parsed.hash)).toBe(true);
    expect(() =>
      transaction.reject(FailureCode.InsufficientFunds, parsed.money, at),
    ).toThrow();
    const balance = Money.zero("BRL");
    transaction.reject(FailureCode.InsufficientFunds, balance, at);
    expect(transaction.isTerminal()).toBe(true);
    expect(String(transaction.failureCode)).toBe("INSUFFICIENT_FUNDS");
    expect(() => transaction.markProcessed(balance, at)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      transaction.reject(FailureCode.InsufficientFunds, balance, at),
    ).toThrow(InvalidTransactionStateError);
    const context = {
      eventId: "event",
      correlationId: transaction.id,
      occurredAt: at,
    };
    expect(() =>
      WagerTransactionProcessed.from(transaction, context),
    ).toThrow();
    expect(
      WagerTransactionRejected.from(transaction, context).toJSON().data
        .failureCode,
    ).toBe("INSUFFICIENT_FUNDS");
  });
});
