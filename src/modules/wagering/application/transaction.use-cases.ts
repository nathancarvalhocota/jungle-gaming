import { randomUUID } from "node:crypto";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../domain/events/opening-events.ts";
import { OutboxMessage } from "../domain/events/outbox-message.ts";
import { WagerTransactionPendingReference } from "../domain/events/transaction-pending-reference.ts";
import { WagerTransactionRejected } from "../domain/events/transaction-rejected.ts";
import { Money } from "../domain/money.ts";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/transactions/wager-transaction.ts";
import {
  invalidTransaction,
  isUuid,
  TransactionApplicationError,
  validateTransaction,
} from "./transaction-input.ts";
import type { TransactionUnitOfWork } from "./transaction-ports.ts";
export class TransactionUseCases {
  constructor(private readonly unitOfWork: TransactionUnitOfWork) {}
  async submit(body: unknown, key: unknown) {
    const validated = validateTransaction(body, key);
    const { input, money, hash } = validated;
    return this.unitOfWork.execute(async (repository) => {
      const existing = await repository.findByKey(validated.key);
      if (existing) return replay(existing, hash);
      const wallet = await repository.lockWallet(input.walletId);
      if (!wallet)
        throw new TransactionApplicationError(
          "WALLET_NOT_FOUND",
          404,
          "Wallet was not found",
        );
      if (
        wallet.playerId !== input.playerId ||
        wallet.currency !== money.currency
      )
        throw new TransactionApplicationError(
          "WALLET_CONTEXT_MISMATCH",
          400,
          "Wallet context does not match",
        );
      const at = new Date();
      const transaction = WagerTransaction.createExternal({
        ...input,
        kind:
          input.kind === "BET"
            ? WagerTransactionKind.Bet
            : input.kind === "WIN"
              ? WagerTransactionKind.Win
              : WagerTransactionKind.Loss,
        money,
        id: randomUUID(),
        idempotencyKey: validated.key,
        payloadHash: hash,
        at,
      });
      if (!(await repository.claim(transaction))) {
        const winner = await repository.findByKey(validated.key);
        if (!winner) throw new Error("Committed idempotency winner is missing");
        return replay(winner, hash);
      }
      const context = { correlationId: transaction.id, occurredAt: at };
      let failure: FailureCode | undefined;
      let referenceId: string | undefined;
      let pendingReference = false;
      if (input.referenceExternalTransactionId !== undefined) {
        if (
          input.referenceExternalTransactionId === input.externalTransactionId
        )
          failure = FailureCode.ReferenceContextMismatch;
        else {
          const reference = await repository.findExternal(
            input.providerId,
            input.referenceExternalTransactionId,
          );
          if (!reference) pendingReference = true;
          else {
            failure = transaction.referenceFailure(reference);
            if (failure !== FailureCode.ReferenceContextMismatch)
              referenceId = reference.id;
            pendingReference =
              failure === undefined &&
              reference.status !== WagerTransactionStatus.Processed;
          }
        }
      }
      if (pendingReference) {
        transaction.markPendingReference(wallet.balance, referenceId);
        await repository.saveTransaction(transaction);
        await repository.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionPendingReference.from(transaction, {
              ...context,
              eventId: randomUUID(),
            }),
          ),
        );
        return result(transaction, false);
      }
      if (!failure && input.kind === "BET" && wallet.balance.isLessThan(money))
        failure = FailureCode.InsufficientFunds;
      if (
        !failure &&
        input.kind === "WIN" &&
        BigInt(wallet.balance.toJSON().amount.replace(".", "")) +
          BigInt(money.toJSON().amount.replace(".", "")) >
          Money.MAX_MINOR_UNITS
      )
        failure = FailureCode.BalanceLimitExceeded;
      if (failure) {
        transaction.reject(failure, wallet.balance, at, referenceId);
        await repository.saveTransaction(transaction);
        await repository.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionRejected.from(transaction, {
              ...context,
              eventId: randomUUID(),
            }),
          ),
        );
      } else {
        const entry =
          input.kind === "LOSS"
            ? undefined
            : wallet[input.kind === "WIN" ? "credit" : "debit"]({
                entryId: randomUUID(),
                transactionId: transaction.id,
                money,
                at,
              });
        transaction.markProcessed(wallet.balance, at, referenceId);
        await repository.saveTransaction(transaction);
        if (entry) {
          await repository.saveWallet(wallet);
          await repository.createLedgerEntry(entry);
        }
        await repository.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(transaction, {
              ...context,
              eventId: randomUUID(),
            }),
          ),
        );
        if (entry)
          await repository.enqueue(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, entry, {
                ...context,
                eventId: randomUUID(),
              }),
            ),
          );
      }
      return result(transaction, false);
    });
  }
  async get(id: string) {
    if (!isUuid(id)) invalidTransaction();
    return this.unitOfWork.execute(async (r) =>
      audit(await r.findTransaction(id.toLowerCase())),
    );
  }
  async getExternal(providerId: string, externalId: string) {
    if (!providerId.trim() || !externalId.trim()) invalidTransaction();
    return this.unitOfWork.execute(async (r) =>
      audit(await r.findExternal(providerId, externalId)),
    );
  }
}
function replay(transaction: WagerTransaction, hash: string) {
  if (!transaction.matchesPayload(hash))
    throw new TransactionApplicationError(
      "IDEMPOTENCY_CONFLICT",
      409,
      "Idempotency key has different content",
    );
  return result(transaction, true);
}
function result(transaction: WagerTransaction, idempotentReplay: boolean) {
  if (
    (!transaction.isTerminal() &&
      transaction.status !== WagerTransactionStatus.PendingReference) ||
    !transaction.balance
  )
    throw new Error("Transaction result is incomplete");
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.balance.toJSON(),
    ...(transaction.failureCode
      ? { failureCode: transaction.failureCode }
      : {}),
    idempotentReplay,
  };
}
function audit(transaction: WagerTransaction | undefined) {
  if (!transaction)
    throw new TransactionApplicationError(
      "TRANSACTION_NOT_FOUND",
      404,
      "Transaction was not found",
    );
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    kind: transaction.kind,
    origin: transaction.origin,
    money: transaction.money.toJSON(),
    status: transaction.status,
    balance: transaction.balance?.toJSON(),
    ...(transaction.failureCode
      ? { failureCode: transaction.failureCode }
      : {}),
    ...(transaction.origin === "EXTERNAL"
      ? {
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          roundId: transaction.roundId,
          gameId: transaction.gameId,
        }
      : {}),
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString(),
    ...(transaction.referenceExternalTransactionId
      ? {
          referenceExternalTransactionId:
            transaction.referenceExternalTransactionId,
        }
      : {}),
    ...(transaction.referenceTransactionId
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
  };
}
