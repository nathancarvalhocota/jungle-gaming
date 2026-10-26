import {
  type WagerTransaction,
  WagerTransactionStatus,
} from "../transactions/wager-transaction.ts";
import { IntegrationEvent } from "./integration-event.ts";
import type {
  EventContext,
  WagerTransactionProcessedData,
} from "./opening-events.ts";
export class WagerTransactionRejected extends IntegrationEvent<
  WagerTransactionProcessedData & { failureCode: string }
> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionRejected {
    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      !transaction.failureCode ||
      !transaction.balance
    )
      throw new Error("A rejected transaction is required");
    const event = new WagerTransactionRejected({
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
        failureCode: transaction.failureCode,
      },
    });
    Object.freeze(event);
    return event;
  }
}
