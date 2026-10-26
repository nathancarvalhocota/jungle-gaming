import type { OutboxMessage } from "../domain/events/outbox-message.ts";
import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry.ts";
import type { WagerTransaction } from "../domain/transactions/wager-transaction.ts";
import type { Wallet } from "../domain/wallet/wallet.ts";

export interface WalletRepositoryPort {
  create(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  createTransaction(transaction: WagerTransaction): Promise<void>;
  createLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  enqueue(message: OutboxMessage): Promise<void>;
}

export interface WalletUnitOfWork {
  execute<T>(
    operation: (repository: WalletRepositoryPort) => Promise<T>,
  ): Promise<T>;
}
