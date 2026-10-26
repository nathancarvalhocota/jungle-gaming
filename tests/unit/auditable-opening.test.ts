import { describe, expect, test } from "bun:test";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../src/modules/wagering/domain/events/opening-events.ts";
import { OutboxMessage } from "../../src/modules/wagering/domain/events/outbox-message.ts";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../src/modules/wagering/domain/ledger/wallet-ledger-entry.ts";
import { Money } from "../../src/modules/wagering/domain/money.ts";
import {
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionError,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/transactions/wager-transaction.ts";
import { Wallet } from "../../src/modules/wagering/domain/wallet/wallet.ts";

const at = new Date("2026-10-25T12:34:56.789Z");
const money = Money.from({ amount: "25.37", currency: "BRL" });
const props = () => ({
  id: "opening",
  walletId: "wallet",
  playerId: "player",
  money,
  at: new Date(at),
});

describe("Auditable opening domain", () => {
  test("starts pending with internal identity and no fabricated external metadata", () => {
    const transaction = WagerTransaction.createOpening(props());
    expect(transaction.origin).toBe("INTERNAL");
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.balance).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.isTerminal()).toBe(false);
    for (const key of [
      "providerId",
      "externalTransactionId",
      "idempotencyKey",
      "payloadHash",
      "roundId",
      "gameId",
    ])
      expect(transaction).not.toHaveProperty(key);
  });

  test("processes once and protects terminal state, balance and dates", () => {
    const input = props();
    const transaction = WagerTransaction.createOpening(input);
    const processedAt = new Date(at);
    transaction.markProcessed(money, processedAt);
    input.at.setTime(0);
    processedAt.setTime(0);
    transaction.createdAt.setTime(0);
    transaction.processedAt?.setTime(0);
    expect(transaction.createdAt).toEqual(at);
    expect(transaction.processedAt).toEqual(at);
    expect(transaction.balance?.toJSON()).toEqual(money.toJSON());
    expect(transaction.isTerminal()).toBe(true);
    expect(Object.isFrozen(transaction)).toBe(true);
    expect(() => transaction.markProcessed(money, at)).toThrow(
      InvalidTransactionStateError,
    );
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });

  test("invalid opening values and processing failures preserve pending state", () => {
    for (const invalidMoney of [Money.zero("BRL"), money.negate()])
      expect(() =>
        WagerTransaction.createOpening({ ...props(), money: invalidMoney }),
      ).toThrow(WagerTransactionError);
    for (const invalid of [
      { ...props(), id: " " },
      { ...props(), walletId: "" },
      { ...props(), playerId: "" },
      { ...props(), at: new Date("invalid") },
    ])
      expect(() => WagerTransaction.createOpening(invalid)).toThrow(
        WagerTransactionError,
      );
    const transaction = WagerTransaction.createOpening(props());
    for (const result of [
      Money.zero("BRL"),
      Money.from({ amount: "25.37", currency: "USD" }),
    ])
      expect(() => transaction.markProcessed(result, at)).toThrow();
    expect(() =>
      transaction.markProcessed(money, new Date("invalid")),
    ).toThrow();
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.balance).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
  });

  test("rehydrates processed state without performing another transition", () => {
    const state = {
      ...props(),
      origin: "INTERNAL" as const,
      kind: WagerTransaction.createOpening(props()).kind,
      status: WagerTransactionStatus.Processed as const,
      balance: money,
      createdAt: new Date(at),
      processedAt: new Date(at),
    };
    const restored = WagerTransaction.rehydrate(state);
    expect(restored.status).toBe(WagerTransactionStatus.Processed);
    expect(restored.processedAt).toEqual(at);
    expect(restored.balance).toBe(money);
    expect(() => restored.markProcessed(money, at)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      WagerTransaction.rehydrate({ ...state, balance: undefined }),
    ).toThrow(WagerTransactionError);
    expect(() =>
      WagerTransaction.rehydrate({
        ...state,
        status: WagerTransactionStatus.Pending,
      }),
    ).toThrow(WagerTransactionError);
  });

  test("events carry protected versioned JSON values and outbox round-trips without publication", () => {
    const transaction = WagerTransaction.createOpening(props());
    expect(() =>
      WagerTransactionProcessed.from(transaction, {
        eventId: "processed-event",
        correlationId: transaction.id,
        occurredAt: at,
      }),
    ).toThrow();
    transaction.markProcessed(money, at);
    const wallet = Wallet.open({
      id: transaction.walletId,
      playerId: transaction.playerId,
      initialBalance: money,
      at,
    });
    const entry = WalletLedgerEntry.create({
      id: "entry",
      transactionId: transaction.id,
      walletId: wallet.id,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore: Money.zero("BRL"),
      balanceAfter: money,
      createdAt: at,
    });
    const sourceDate = new Date(at);
    const events = [
      WagerTransactionProcessed.from(transaction, {
        eventId: "processed-event",
        correlationId: transaction.id,
        occurredAt: sourceDate,
      }),
      WalletBalanceChanged.from(wallet, entry, {
        eventId: "balance-event",
        correlationId: transaction.id,
        occurredAt: sourceDate,
      }),
    ];
    sourceDate.setTime(0);
    for (const event of events) {
      event.occurredAt.setTime(0);
      expect(event.occurredAt).toEqual(at);
      expect(event.version).toBe(1);
      expect(event.data.money).toEqual(money.toJSON());
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.data)).toBe(true);
      expect(Object.isFrozen(event.data.money)).toBe(true);
      const json = event.toJSON();
      json.data.money.amount = "0.00";
      expect(event.data.money.amount).toBe("25.37");
      const message = OutboxMessage.enqueue(event);
      expect(message.isPending()).toBe(true);
      expect(message.attempts).toBe(0);
      expect(message.nextAttemptAt).toBeUndefined();
      expect(message.publishedAt).toBeUndefined();
      expect(message.payload).toEqual(event.toJSON());
      expect(Object.isFrozen(message)).toBe(true);
      expect(Object.isFrozen(message.payload.data)).toBe(true);
      expect(JSON.parse(JSON.stringify(message.payload))).toEqual(
        message.payload,
      );
      const payload = { ...structuredClone(message.payload) };
      const restored = OutboxMessage.rehydrate({
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload,
        occurredAt: new Date(at),
        attempts: 0,
        nextAttemptAt: undefined,
        publishedAt: undefined,
      });
      payload.eventType = "changed";
      restored.occurredAt.setTime(0);
      expect(restored.payload.eventType).toBe(message.eventType);
      expect(restored.occurredAt).toEqual(at);
      expect(restored.isPending()).toBe(true);
    }
  });

  test("outbox rejects non-JSON data and inconsistent envelope metadata", () => {
    const transaction = WagerTransaction.createOpening(props());
    transaction.markProcessed(money, at);
    const message = OutboxMessage.enqueue(
      WagerTransactionProcessed.from(transaction, {
        eventId: "event",
        correlationId: transaction.id,
        occurredAt: at,
      }),
    );
    const state = {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: new Date(at),
      attempts: 0,
      nextAttemptAt: undefined,
      publishedAt: undefined,
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      1n,
      new Date(at),
      new Map(),
      undefined,
      Infinity,
      cyclic,
    ])
      expect(() =>
        OutboxMessage.rehydrate({
          ...state,
          payload: { ...state.payload, extra: value },
        }),
      ).toThrow();
    expect(() => OutboxMessage.rehydrate({ ...state, attempts: -1 })).toThrow();
    expect(() =>
      OutboxMessage.rehydrate({ ...state, id: "different" }),
    ).toThrow();
  });
});
