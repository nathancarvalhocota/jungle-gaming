import type { WalletLedgerEntry } from "../ledger/wallet-ledger-entry.ts";
import type { MoneyProps } from "../money.ts";
import type { WagerTransaction } from "../transactions/wager-transaction.ts";
import type { Wallet } from "../wallet/wallet.ts";
import { IntegrationEvent } from "./integration-event.ts";

export interface EventContext {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionProcessed {
    if (!transaction.isTerminal() || !transaction.balance)
      throw new Error("A processed transaction is required");
    const event = new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        kind: transaction.kind,
        status: transaction.status,
        money: transaction.money.toJSON(),
        balance: transaction.balance.toJSON(),
      },
    });
    Object.freeze(event);
    return event;
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    if (
      entry.walletId !== wallet.id ||
      !entry.balanceAfter.equals(wallet.balance) ||
      !entry.money.isPositive()
    )
      throw new Error("A matching wallet movement is required");
    const event = new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
    Object.freeze(event);
    return event;
  }
}
