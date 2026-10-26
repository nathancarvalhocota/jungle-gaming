import { IsolationLevel, LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { TransactionApplicationError } from "../../application/transaction-input.ts";
import type {
  TransactionRepositoryPort,
  TransactionUnitOfWork,
} from "../../application/transaction-ports.ts";
import type { WagerTransaction } from "../../domain/transactions/wager-transaction.ts";
import type { Wallet } from "../../domain/wallet/wallet.ts";
import { WagerTransactionSchema } from "./opening.schema.ts";
import { WalletRepository } from "./wallet.repository.ts";
import { WalletSchema } from "./wallet.schema.ts";
export class TransactionRepository
  extends WalletRepository
  implements TransactionRepositoryPort
{
  constructor(private readonly transactionEm: EntityManager) {
    super(transactionEm);
  }
  async findByKey(idempotencyKey: string) {
    const row = await this.transactionEm.findOne(WagerTransactionSchema, {
      idempotencyKey,
    });
    return row ? this.findTransaction(row.id) : undefined;
  }
  async findExternal(providerId: string, externalTransactionId: string) {
    const row = await this.transactionEm.findOne(WagerTransactionSchema, {
      providerId,
      externalTransactionId,
    });
    return row ? this.findTransaction(row.id) : undefined;
  }
  async lockWallet(id: string) {
    const row = await this.transactionEm.findOne(
      WalletSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return row ? this.findById(id) : undefined;
  }
  async claim(transaction: WagerTransaction): Promise<boolean> {
    const rows = await this.transactionEm
      .createQueryBuilder(WagerTransactionSchema)
      .insert({
        id: transaction.id,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        origin: transaction.origin,
        kind: transaction.kind,
        status: transaction.status,
        currency: transaction.money.currency,
        moneyMinorUnits: units(transaction.money.toJSON().amount),
        balanceMinorUnits: null,
        createdAt: transaction.createdAt,
        processedAt: null,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: transaction.idempotencyKey,
        payloadHash: transaction.payloadHash,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        failureCode: null,
      })
      .onConflict("idempotencyKey")
      .ignore()
      .returning("id")
      .execute<{ id: string }[]>("all");
    return rows.length === 1;
  }
  async saveTransaction(transaction: WagerTransaction): Promise<void> {
    await this.transactionEm
      .createQueryBuilder(WagerTransactionSchema)
      .update({
        status: transaction.status,
        balanceMinorUnits: transaction.balance
          ? units(transaction.balance.toJSON().amount)
          : null,
        processedAt: transaction.processedAt ?? null,
        failureCode: transaction.failureCode ?? null,
      })
      .where({ id: transaction.id })
      .execute();
  }
  async saveWallet(wallet: Wallet): Promise<void> {
    await this.transactionEm
      .createQueryBuilder(WalletSchema)
      .update({
        balanceMinorUnits: units(wallet.balance.toJSON().amount),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      })
      .where({ id: wallet.id })
      .execute();
  }
}
function units(amount: string): bigint {
  return BigInt(amount.replace(".", ""));
}
export class MikroOrmTransactionUnitOfWork implements TransactionUnitOfWork {
  constructor(private readonly em: EntityManager) {}
  async execute<T>(
    operation: (repository: TransactionRepositoryPort) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (em) => {
          await em.execute("set local lock_timeout = '5s'");
          await em.execute("set local statement_timeout = '15s'");
          return operation(new TransactionRepository(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error: unknown) {
      if (hasSqlError(error, "23505", "transactions_external_identity_unique"))
        throw new TransactionApplicationError(
          "EXTERNAL_TRANSACTION_CONFLICT",
          409,
          "External transaction already has another key",
          { cause: error },
        );
      if (
        ["40P01", "55P03", "57014", "40001"].some((code) =>
          hasSqlError(error, code),
        )
      )
        throw new TransactionApplicationError(
          "TRANSACTION_RETRY_REQUIRED",
          503,
          "Transaction must be retried with the same key",
          { cause: error },
        );
      throw error;
    }
  }
}
export function hasSqlError(
  error: unknown,
  code: string,
  constraint?: string,
  visited = new Set<unknown>(),
): boolean {
  if (typeof error !== "object" || error === null || visited.has(error))
    return false;
  visited.add(error);
  const record = error as Record<string, unknown>;
  return (
    (record.code === code &&
      (constraint === undefined || record.constraint === constraint)) ||
    hasSqlError(record.cause, code, constraint, visited)
  );
}
