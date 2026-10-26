import type { EntityManager } from "@mikro-orm/postgresql";
import { WalletAlreadyExistsError } from "../../application/wallet.errors.ts";
import { OutboxMessage } from "../../domain/events/outbox-message.ts";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/ledger/wallet-ledger-entry.ts";
import { Money } from "../../domain/money.ts";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/transactions/wager-transaction.ts";
import { Wallet } from "../../domain/wallet/wallet.ts";
import {
  OutboxMessageSchema,
  WagerTransactionSchema,
  type WalletLedgerEntryRecord,
  WalletLedgerEntrySchema,
} from "./opening.schema.ts";
import { type WalletRecord, WalletSchema } from "./wallet.schema.ts";

export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async create(wallet: Wallet): Promise<void> {
    const record = this.em.create(WalletSchema, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceMinorUnits: BigInt(
        wallet.balance.toJSON().amount.replace(".", ""),
      ),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    try {
      this.em.persist(record);
      await this.em.flush();
    } catch (error: unknown) {
      if (isWalletUniqueViolation(error)) {
        throw new WalletAlreadyExistsError(
          "A wallet already exists for this player and currency",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id });
    return record ? this.toDomain(record) : undefined;
  }

  async createTransaction(transaction: WagerTransaction): Promise<void> {
    this.em.persist(
      this.em.create(WagerTransactionSchema, {
        id: transaction.id,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        origin: transaction.origin,
        kind: transaction.kind,
        status: transaction.status,
        currency: transaction.money.currency,
        moneyMinorUnits: minorUnits(transaction.money),
        balanceMinorUnits: transaction.balance
          ? minorUnits(transaction.balance)
          : null,
        createdAt: transaction.createdAt,
        processedAt: transaction.processedAt ?? null,
        providerId: transaction.providerId ?? null,
        externalTransactionId: transaction.externalTransactionId ?? null,
        idempotencyKey: transaction.idempotencyKey ?? null,
        payloadHash: transaction.payloadHash ?? null,
        roundId: transaction.roundId ?? null,
        gameId: transaction.gameId ?? null,
        failureCode: transaction.failureCode ?? null,
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId ?? null,
        referenceTransactionId: transaction.referenceTransactionId ?? null,
      }),
    );
    await this.em.flush();
  }

  async findTransaction(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { id });
    if (!record) return undefined;
    if (
      (record.origin !== "INTERNAL" && record.origin !== "EXTERNAL") ||
      (record.kind !== WagerTransactionKind.Opening &&
        record.kind !== WagerTransactionKind.Bet &&
        record.kind !== WagerTransactionKind.Win &&
        record.kind !== WagerTransactionKind.Loss &&
        record.kind !== WagerTransactionKind.Refund &&
        record.kind !== WagerTransactionKind.Rollback) ||
      (record.status !== WagerTransactionStatus.Pending &&
        record.status !== WagerTransactionStatus.Processed &&
        record.status !== WagerTransactionStatus.Rejected &&
        record.status !== WagerTransactionStatus.PendingReference) ||
      (record.failureCode != null &&
        !Object.values(FailureCode).includes(record.failureCode as FailureCode))
    )
      throw new Error("Unsupported stored transaction");
    return WagerTransaction.rehydrate({
      id: record.id,
      walletId: record.walletId,
      playerId: record.playerId,
      origin: record.origin,
      kind: record.kind,
      ...(record.origin === "EXTERNAL"
        ? {
            external: {
              providerId: record.providerId ?? "",
              externalTransactionId: record.externalTransactionId ?? "",
              idempotencyKey: record.idempotencyKey ?? "",
              payloadHash: record.payloadHash ?? "",
              roundId: record.roundId ?? "",
              gameId: record.gameId ?? "",
            },
          }
        : {}),
      failureCode: (record.failureCode as FailureCode | null) ?? undefined,
      referenceExternalTransactionId:
        record.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      status: record.status,
      money: readMoney(record.moneyMinorUnits, record.currency),
      balance:
        record.balanceMinorUnits == null
          ? undefined
          : readMoney(record.balanceMinorUnits, record.currency),
      createdAt: record.createdAt,
      processedAt: record.processedAt ?? undefined,
    });
  }

  async createLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(
      this.em.create(WalletLedgerEntrySchema, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        currency: entry.money.currency,
        moneyMinorUnits: minorUnits(entry.money),
        balanceBeforeMinorUnits: minorUnits(entry.balanceBefore),
        balanceAfterMinorUnits: minorUnits(entry.balanceAfter),
        createdAt: entry.createdAt,
      }),
    );
    await this.em.flush();
  }

  async findLedgerEntry(id: string): Promise<WalletLedgerEntry | undefined> {
    const record = await this.em.findOne(WalletLedgerEntrySchema, { id });
    if (!record) return undefined;
    return toLedgerDomain(record);
  }

  async listLedgerEntries(
    walletId: string,
    limit: number,
    entryId?: string,
  ): Promise<WalletLedgerEntry[] | undefined> {
    if (entryId) {
      const anchors = await this.em.execute<{ id: string }[]>(
        "select id from wallet_ledger_entries where wallet_id = ? and id = ?",
        [walletId, entryId],
      );
      if (anchors.length === 0) return undefined;
    }
    const rows = await this.em.execute<{ id: string }[]>(
      `select entry.id from wallet_ledger_entries entry
       where entry.wallet_id = ? ${
         entryId
           ? `and (entry.created_at, entry.id) < (
         select anchor.created_at, anchor.id from wallet_ledger_entries anchor
         where anchor.wallet_id = ? and anchor.id = ?)`
           : ""
       }
       order by entry.created_at desc, entry.id desc limit ?`,
      entryId ? [walletId, walletId, entryId, limit] : [walletId, limit],
    );
    const records = await this.em.find(WalletLedgerEntrySchema, {
      id: { $in: rows.map((row) => row.id) },
    });
    const byId = new Map(records.map((record) => [record.id, record]));
    return rows.map((row) => {
      const record = byId.get(row.id);
      if (!record) throw new Error("Stored ledger entry disappeared");
      return toLedgerDomain(record);
    });
  }

  async enqueue(message: OutboxMessage): Promise<void> {
    this.em.persist(
      this.em.create(OutboxMessageSchema, {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload,
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      }),
    );
    await this.em.flush();
  }

  async findOutboxMessage(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(OutboxMessageSchema, { id });
    return record
      ? OutboxMessage.rehydrate({
          ...record,
          nextAttemptAt: record.nextAttemptAt ?? undefined,
          publishedAt: record.publishedAt ?? undefined,
        })
      : undefined;
  }

  private toDomain(record: WalletRecord): Wallet {
    const balance = Money.from({
      amount: formatMinorUnits(BigInt(record.balanceMinorUnits)),
      currency: record.currency,
    });
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}

function minorUnits(money: Money): bigint {
  return BigInt(money.toJSON().amount.replace(".", ""));
}
function readMoney(value: bigint, currency: string): Money {
  return Money.from({ amount: formatMinorUnits(BigInt(value)), currency });
}

function formatMinorUnits(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}

function isWalletUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (
    record.code === "23505" &&
    record.constraint === "wallets_player_currency_unique"
  ) {
    return true;
  }
  return "cause" in record && isWalletUniqueViolation(record.cause);
}

function toLedgerDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
  if (
    record.direction !== LedgerDirection.Credit &&
    record.direction !== LedgerDirection.Debit
  )
    throw new Error("Invalid stored ledger direction");
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction,
    money: readMoney(record.moneyMinorUnits, record.currency),
    balanceBefore: readMoney(record.balanceBeforeMinorUnits, record.currency),
    balanceAfter: readMoney(record.balanceAfterMinorUnits, record.currency),
    createdAt: record.createdAt,
  });
}
