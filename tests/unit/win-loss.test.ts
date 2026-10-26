import { describe, expect, test } from "bun:test";
import {
  validateBet,
  validateTransaction,
} from "../../src/modules/wagering/application/transaction-input.ts";
import { WagerTransactionPendingReference } from "../../src/modules/wagering/domain/events/transaction-pending-reference.ts";
import { Money } from "../../src/modules/wagering/domain/money.ts";
import {
  FailureCode,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/transactions/wager-transaction.ts";

const body = {
  providerId: "provider",
  externalTransactionId: "external",
  playerId: "player",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round",
  gameId: "game",
  kind: "BET",
  money: { amount: "1.00", currency: "BRL" },
};
function transaction(
  kind: WagerTransactionKind.Win | WagerTransactionKind.Loss,
  referenceExternalTransactionId?: string,
) {
  return WagerTransaction.createExternal({
    ...body,
    money: Money.from(body.money),
    id: `internal-${kind}`,
    idempotencyKey: "key",
    payloadHash: validateBet(body, "key").hash,
    at: new Date(),
    kind,
    ...(referenceExternalTransactionId
      ? { referenceExternalTransactionId }
      : {}),
  });
}
describe("WIN/LOSS input and domain", () => {
  test("rehydration restores pending state without transitions and rejects inconsistent reference results", () => {
    const tx = transaction(WagerTransactionKind.Win, "bet");
    const state: WagerTransactionState = {
      id: tx.id,
      walletId: tx.walletId,
      playerId: tx.playerId,
      money: tx.money,
      origin: "EXTERNAL",
      kind: WagerTransactionKind.Win,
      external: {
        ...body,
        payloadHash: validateBet(body, "key").hash,
        idempotencyKey: "key",
      },
      referenceExternalTransactionId: "bet",
      referenceTransactionId: "known-id",
      status: WagerTransactionStatus.PendingReference,
      balance: Money.zero("BRL"),
      createdAt: new Date(),
      processedAt: undefined,
    };
    const restored = WagerTransaction.rehydrate(state);
    expect(restored.status).toBe(WagerTransactionStatus.PendingReference);
    expect(restored.referenceTransactionId).toBe("known-id");
    expect(restored.balance?.toJSON()).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
    expect(restored.processedAt).toBeUndefined();
    const invalidStates: WagerTransactionState[] = [
      { ...state, balance: undefined },
      { ...state, processedAt: new Date() },
      { ...state, failureCode: FailureCode.ReferenceNotProcessed },
      { ...state, referenceTransactionId: tx.id },
      { ...state, referenceExternalTransactionId: undefined },
      { ...state, balance: Money.zero("USD") },
      {
        ...state,
        status: WagerTransactionStatus.Processed,
        processedAt: new Date(),
        referenceTransactionId: undefined,
      },
    ];
    for (const invalid of invalidStates)
      expect(() => WagerTransaction.rehydrate(invalid)).toThrow();
  });
  test("preserves the literal BET hash calculated before extending its contract", () => {
    expect(validateBet(body, "key").hash).toBe(
      "7a3dd0ad62dabaadbf69c32a07c9d8a2f211254bf88c0ffb4681964773d3149c",
    );
    expect(validateTransaction(body, "other").hash).toBe(
      validateBet(body, "key").hash,
    );
  });
  test("WIN positive and LOSS zero use strict optional reference and canonical hashing", () => {
    expect(
      validateTransaction(
        { ...body, kind: "LOSS", money: { amount: "0.00", currency: "BRL" } },
        "key",
      ).money.isZero(),
    ).toBe(true);
    const win = { ...body, kind: "WIN" };
    const noReference = validateTransaction(win, "key");
    const referenced = validateTransaction(
      { ...win, referenceExternalTransactionId: "bet" },
      "key",
    );
    expect(referenced.hash).not.toBe(noReference.hash);
    expect(
      validateTransaction(
        {
          referenceExternalTransactionId: "bet",
          ...win,
          money: { currency: "BRL", amount: "1.00" },
        },
        "other",
      ).hash,
    ).toBe(referenced.hash);
    for (const invalid of [null, undefined, "", " ", 1])
      expect(() =>
        validateTransaction(
          { ...win, referenceExternalTransactionId: invalid },
          "key",
        ),
      ).toThrow();
    for (const invalid of [
      { ...win, money: { amount: "0.00", currency: "BRL" } },
      { ...win, unknown: true },
      { ...body, referenceExternalTransactionId: "bet" },
    ])
      expect(() => validateTransaction(invalid, "key")).toThrow();
  });
  test("pending reference is nonterminal, reconstructs exactly and transitions explicitly", () => {
    const tx = transaction(WagerTransactionKind.Win, "bet");
    const balance = Money.from({ amount: "10.00", currency: "BRL" });
    tx.markPendingReference(balance, "bet-internal");
    expect(tx.isTerminal()).toBe(false);
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    const event = WagerTransactionPendingReference.from(tx, {
      eventId: "event",
      correlationId: tx.id,
      occurredAt: new Date(),
    });
    expect(event.toJSON()).toMatchObject({
      eventType: "WagerTransactionPendingReference",
      version: 1,
      correlationId: tx.id,
      data: {
        referenceExternalTransactionId: "bet",
        referenceTransactionId: "bet-internal",
        money: body.money,
        balance: balance.toJSON(),
      },
    });
    tx.markProcessed(balance, new Date(), "bet-internal");
    expect(() => tx.markPendingReference(balance)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      tx.reject(FailureCode.ReferenceNotProcessed, balance, new Date()),
    ).toThrow(InvalidTransactionStateError);
    expect(() =>
      transaction(WagerTransactionKind.Win, "bet").markProcessed(
        balance,
        new Date(),
      ),
    ).toThrow();
    expect(() =>
      transaction(WagerTransactionKind.Loss).markPendingReference(balance),
    ).toThrow();
  });
  test("domain validates linked identity, context and kind before reference status", () => {
    const tx = transaction(WagerTransactionKind.Win, "external");
    const bet = WagerTransaction.createBet({
      ...body,
      money: Money.from(body.money),
      id: "bet-id",
      idempotencyKey: "bet-key",
      payloadHash: validateBet(body, "key").hash,
      at: new Date(),
    });
    expect(tx.referenceFailure(bet)).toBeUndefined();
    const other = transaction(WagerTransactionKind.Loss);
    expect(tx.referenceFailure(other)).toBe(FailureCode.ReferenceKindMismatch);
    expect(
      transaction(WagerTransactionKind.Win, "wrong").referenceFailure(bet),
    ).toBe(FailureCode.ReferenceContextMismatch);
    bet.reject(FailureCode.InsufficientFunds, Money.zero("BRL"), new Date());
    expect(tx.referenceFailure(bet)).toBe(FailureCode.ReferenceNotProcessed);
  });
});
