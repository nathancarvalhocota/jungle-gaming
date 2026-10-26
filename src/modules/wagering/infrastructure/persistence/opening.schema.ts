import { defineEntity, type InferEntity, p } from "@mikro-orm/core";

export const WagerTransactionSchema = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid().fieldName("wallet_id"),
    playerId: p.text().fieldName("player_id"),
    origin: p.text(),
    kind: p.text(),
    status: p.text(),
    currency: p.string().length(3),
    moneyMinorUnits: p.bigint().fieldName("money_minor_units"),
    balanceMinorUnits: p.bigint().nullable().fieldName("balance_minor_units"),
    createdAt: p.datetime().fieldName("created_at"),
    processedAt: p.datetime().nullable().fieldName("processed_at"),
    providerId: p.text().nullable().fieldName("provider_id"),
    externalTransactionId: p
      .text()
      .nullable()
      .fieldName("external_transaction_id"),
    idempotencyKey: p.text().nullable().fieldName("idempotency_key"),
    payloadHash: p.text().nullable().fieldName("payload_hash"),
    roundId: p.text().nullable().fieldName("round_id"),
    gameId: p.text().nullable().fieldName("game_id"),
    failureCode: p.text().nullable().fieldName("failure_code"),
  },
});
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionSchema>;

export const WalletLedgerEntrySchema = defineEntity({
  name: "WalletLedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid().fieldName("wallet_id"),
    transactionId: p.uuid().fieldName("transaction_id"),
    direction: p.text(),
    currency: p.string().length(3),
    moneyMinorUnits: p.bigint().fieldName("money_minor_units"),
    balanceBeforeMinorUnits: p.bigint().fieldName("balance_before_minor_units"),
    balanceAfterMinorUnits: p.bigint().fieldName("balance_after_minor_units"),
    createdAt: p.datetime().fieldName("created_at"),
  },
  uniques: [
    {
      name: "ledger_transaction_wallet_unique",
      properties: ["transactionId", "walletId"],
    },
  ],
});
export type WalletLedgerEntryRecord = InferEntity<
  typeof WalletLedgerEntrySchema
>;

export const OutboxMessageSchema = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid().fieldName("aggregate_id"),
    eventType: p.text().fieldName("event_type"),
    payload: p.json<Readonly<Record<string, unknown>>>(),
    occurredAt: p.datetime().fieldName("occurred_at"),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable().fieldName("next_attempt_at"),
    publishedAt: p.datetime().nullable().fieldName("published_at"),
  },
});
export type OutboxMessageRecord = InferEntity<typeof OutboxMessageSchema>;
