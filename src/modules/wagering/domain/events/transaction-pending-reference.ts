import {
  type WagerTransaction,
  WagerTransactionStatus,
} from "../transactions/wager-transaction.ts";
import { IntegrationEvent } from "./integration-event.ts";
import type {
  EventContext,
  WagerTransactionProcessedData,
} from "./opening-events.ts";

export class WagerTransactionPendingReference extends IntegrationEvent<
  WagerTransactionProcessedData & {
    referenceExternalTransactionId: string;
    referenceTransactionId?: string;
  }
> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      !transaction.balance ||
      !transaction.referenceExternalTransactionId
    )
      throw new Error("A pending reference transaction is required");
    const event = new WagerTransactionPendingReference({
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
        referenceExternalTransactionId:
          transaction.referenceExternalTransactionId,
        ...(transaction.referenceTransactionId
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
      },
    });
    Object.freeze(event);
    return event;
  }
}
