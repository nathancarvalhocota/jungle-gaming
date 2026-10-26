import { describe, expect, test } from "bun:test";
import { validateTransaction } from "../../src/modules/wagering/application/transaction-input.ts";
import { LedgerDirection } from "../../src/modules/wagering/domain/ledger/wallet-ledger-entry.ts";
import { Money } from "../../src/modules/wagering/domain/money.ts";
import {
  FailureCode,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/transactions/wager-transaction.ts";

const body = {
  providerId: "provider",
  externalTransactionId: "external",
  playerId: "player",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round",
  gameId: "game",
  kind: "ROLLBACK",
  money: { amount: "1.00", currency: "BRL" },
  referenceExternalTransactionId: "bet",
};
function transaction(
  kind:
    | WagerTransactionKind.Bet
    | WagerTransactionKind.Win
    | WagerTransactionKind.Refund
    | WagerTransactionKind.Rollback,
  externalTransactionId: string,
  referenceExternalTransactionId?: string,
) {
  return WagerTransaction.createExternal({
    ...body,
    id: `${externalTransactionId}-id`,
    kind,
    externalTransactionId,
    referenceExternalTransactionId,
    money: Money.from(body.money),
    idempotencyKey: externalTransactionId,
    payloadHash: validateTransaction(body, "key").hash,
    at: new Date(),
  });
}
describe("ROLLBACK domain and input", () => {
  test("preserves all literal hash vectors calculated from base 4a5ae90", () => {
    const { referenceExternalTransactionId: _reference, ...plain } = body;
    for (const [kind, reference, hash] of [
      [
        "BET",
        undefined,
        "7a3dd0ad62dabaadbf69c32a07c9d8a2f211254bf88c0ffb4681964773d3149c",
      ],
      [
        "WIN",
        undefined,
        "7162fec64ae3faf6888cad046739b1fa9194a608ca4a3e3773021c5c43fd363b",
      ],
      [
        "WIN",
        "bet",
        "f5f22b5f9c3e205f3ad72c0a259a2e1756411a0a8813d132f53a5003f7be5b92",
      ],
      [
        "LOSS",
        undefined,
        "4a2142994021f7a98a5dd85076b4b8da7617c58527ab5cf169fbe9635b7f56b8",
      ],
      [
        "LOSS",
        "bet",
        "550c70decb338be81e581053ca3601c4a786667ad4c6fac4a6266e5fc88a8c43",
      ],
      [
        "REFUND",
        "bet",
        "41c7a30a4c6836f5176e4b6a2a71f5aed67aae3ec030a5a31b170ace1dc3ed72",
      ],
    ] as const)
      expect(
        validateTransaction(
          {
            ...plain,
            kind,
            ...(reference ? { referenceExternalTransactionId: reference } : {}),
          },
          "key",
        ).hash,
      ).toBe(hash);
  });
  test("requires a positive exact amount and a mandatory nonempty reference in contract and factory", () => {
    const { referenceExternalTransactionId: _reference, ...withoutReference } =
      body;
    for (const invalid of [
      withoutReference,
      ...[null, undefined, "", " ", 1].map(
        (referenceExternalTransactionId) => ({
          ...body,
          referenceExternalTransactionId,
        }),
      ),
      { ...body, money: { amount: "0.00", currency: "BRL" } },
    ])
      expect(() => validateTransaction(invalid, "key")).toThrow();
    expect(() =>
      transaction(WagerTransactionKind.Rollback, "rollback"),
    ).toThrow();
    expect(() =>
      transaction(WagerTransactionKind.Rollback, "rollback", ""),
    ).toThrow();
    expect(validateTransaction(body, "key").hash).not.toBe(
      validateTransaction(
        { ...body, referenceExternalTransactionId: "other" },
        "key",
      ).hash,
    );
  });
  test("domain chooses inverse direction only for an eligible processed reference", () => {
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ] as const) {
      const reference = transaction(
        kind,
        "bet",
        kind === WagerTransactionKind.Refund ? "prior-bet" : undefined,
      );
      const rollback = transaction(
        WagerTransactionKind.Rollback,
        "rollback",
        "bet",
      );
      expect(() => rollback.ledgerDirectionFor(reference)).toThrow();
      reference.markProcessed(
        Money.from(body.money),
        new Date(),
        kind === WagerTransactionKind.Refund ? "prior-bet-id" : undefined,
      );
      expect(rollback.ledgerDirectionFor(reference)).toBe(
        kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit,
      );
    }
    const reference = transaction(
      WagerTransactionKind.Rollback,
      "bet",
      "prior",
    );
    reference.markProcessed(Money.zero("BRL"), new Date(), "prior-id");
    expect(
      transaction(
        WagerTransactionKind.Rollback,
        "rollback",
        "bet",
      ).referenceFailure(reference),
    ).toBe(FailureCode.ReferenceKindMismatch);
    const opening = WagerTransaction.createOpening({
      id: "opening",
      walletId: body.walletId,
      playerId: body.playerId,
      money: Money.from(body.money),
      at: new Date(),
    });
    expect(
      transaction(
        WagerTransactionKind.Rollback,
        "rollback",
        "bet",
      ).referenceFailure(opening),
    ).toBe(FailureCode.ReferenceContextMismatch);
  });
  test("reversal insufficient funds is distinct, rehydrates and cannot transition after rejection", () => {
    const tx = transaction(WagerTransactionKind.Rollback, "rollback", "bet");
    tx.reject(
      FailureCode.ReversalInsufficientFunds,
      Money.zero("BRL"),
      new Date(),
      "bet-id",
    );
    expect(tx.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    const restored = WagerTransaction.rehydrate({
      id: tx.id,
      walletId: tx.walletId,
      playerId: tx.playerId,
      origin: "EXTERNAL",
      kind: WagerTransactionKind.Rollback,
      external: {
        ...body,
        idempotencyKey: "rollback",
        payloadHash: validateTransaction(body, "key").hash,
        externalTransactionId: "rollback",
      },
      money: tx.money,
      referenceExternalTransactionId: "bet",
      referenceTransactionId: "bet-id",
      status: WagerTransactionStatus.Rejected,
      failureCode: tx.failureCode,
      balance: tx.balance,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt,
    });
    expect(restored.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(() =>
      restored.markProcessed(Money.zero("BRL"), new Date(), "bet-id"),
    ).toThrow(InvalidTransactionStateError);
    expect(() =>
      restored.markPendingReference(Money.zero("BRL"), "bet-id"),
    ).toThrow(InvalidTransactionStateError);
    expect(() =>
      transaction(WagerTransactionKind.Win, "win").reject(
        FailureCode.ReversalInsufficientFunds,
        Money.zero("BRL"),
        new Date(),
      ),
    ).toThrow();
    expect(() =>
      transaction(WagerTransactionKind.Rollback, "other", "bet").reject(
        FailureCode.ReversalInsufficientFunds,
        Money.from(body.money),
        new Date(),
        "bet-id",
      ),
    ).toThrow();
  });
});
