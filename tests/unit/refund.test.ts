import { describe, expect, test } from "bun:test";
import { validateTransaction } from "../../src/modules/wagering/application/transaction-input.ts";
import { Money } from "../../src/modules/wagering/domain/money.ts";
import {
  FailureCode,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/modules/wagering/domain/transactions/wager-transaction.ts";

const body = {
  providerId: "provider",
  externalTransactionId: "refund",
  playerId: "player",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round",
  gameId: "game",
  kind: "REFUND",
  money: { amount: "1.00", currency: "BRL" },
  referenceExternalTransactionId: "bet",
};
function refund(referenceExternalTransactionId: string | undefined = "bet") {
  return WagerTransaction.createExternal({
    ...body,
    referenceExternalTransactionId,
    id: "refund-id",
    kind: WagerTransactionKind.Refund,
    money: Money.from(body.money),
    idempotencyKey: "key",
    payloadHash: validateTransaction(body, "key").hash,
    at: new Date(),
  });
}
describe("REFUND domain", () => {
  test("preserves literal WIN/LOSS hash vectors from base 3b73bb3", () => {
    for (const [kind, reference, hash] of [
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
    ] as const) {
      const { referenceExternalTransactionId: _reference, ...input } = body;
      expect(
        validateTransaction(
          {
            ...input,
            externalTransactionId: "external",
            kind,
            ...(reference ? { referenceExternalTransactionId: reference } : {}),
          },
          "key",
        ).hash,
      ).toBe(hash);
    }
  });
  test("requires positive exact money and a nonempty external reference in input and factory", () => {
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
    expect(() => refund("")).toThrow();
    expect(() =>
      WagerTransaction.createExternal({
        ...withoutReference,
        kind: WagerTransactionKind.Refund,
        id: "missing-reference",
        money: Money.from(body.money),
        idempotencyKey: "key",
        payloadHash: validateTransaction(body, "key").hash,
        at: new Date(),
      }),
    ).toThrow();
    const tx = refund();
    expect(tx.kind).toBe(WagerTransactionKind.Refund);
    expect(String(tx.status)).toBe("PENDING");
    expect(
      validateTransaction(
        { ...body, referenceExternalTransactionId: "other" },
        "key",
      ).hash,
    ).not.toBe(validateTransaction(body, "key").hash);
  });
  test("amount is evaluated only after eligible processed BET; terminal rejections cannot transition", () => {
    const { referenceExternalTransactionId: _reference, ...betBody } = body;
    const bet = WagerTransaction.createBet({
      ...betBody,
      externalTransactionId: "bet",
      id: "bet-id",
      money: Money.from({ amount: "2.00", currency: "BRL" }),
      idempotencyKey: "bet-key",
      payloadHash: validateTransaction(body, "key").hash,
      at: new Date(),
    });
    const tx = refund();
    expect(tx.referenceFailure(bet)).toBeUndefined();
    bet.markProcessed(Money.zero("BRL"), new Date());
    expect(tx.referenceFailure(bet)).toBe(FailureCode.ReferenceAmountMismatch);
    tx.reject(
      FailureCode.ReferenceAmountMismatch,
      Money.zero("BRL"),
      new Date(),
      bet.id,
    );
    expect(tx.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    expect(() =>
      tx.markProcessed(Money.zero("BRL"), new Date(), bet.id),
    ).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference(Money.zero("BRL"), bet.id)).toThrow(
      InvalidTransactionStateError,
    );
  });
});
