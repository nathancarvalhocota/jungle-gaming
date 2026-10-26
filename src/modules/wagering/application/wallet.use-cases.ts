import { randomUUID } from "node:crypto";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../domain/events/opening-events.ts";
import { OutboxMessage } from "../domain/events/outbox-message.ts";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../domain/ledger/wallet-ledger-entry.ts";
import { Money, MoneyError } from "../domain/money.ts";
import { WagerTransaction } from "../domain/transactions/wager-transaction.ts";
import { Wallet } from "../domain/wallet/wallet.ts";
import {
  InvalidWalletInputError,
  UnsupportedWalletCurrencyError,
  WalletNotFoundError,
} from "./wallet.errors.ts";
import type { WalletUnitOfWork } from "./wallet-ports.ts";
export interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export class WalletUseCases {
  constructor(private readonly unitOfWork: WalletUnitOfWork) {}

  async create(input: unknown): Promise<WalletView> {
    const props = validateCreateWalletInput(input);
    const at = new Date();
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: props.playerId,
      initialBalance: props.initialBalance,
      at,
    });
    await this.unitOfWork.execute(async (repository) => {
      await repository.create(wallet);
      if (props.initialBalance.isZero()) return;
      const opening = WagerTransaction.createOpening({
        id: randomUUID(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: props.initialBalance,
        at,
      });
      const entry = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: props.initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: wallet.balance,
        createdAt: at,
      });
      opening.markProcessed(wallet.balance, at);
      await repository.createTransaction(opening);
      await repository.createLedgerEntry(entry);
      const context = { correlationId: opening.id, occurredAt: at };
      await repository.enqueue(
        OutboxMessage.enqueue(
          WagerTransactionProcessed.from(opening, {
            ...context,
            eventId: randomUUID(),
          }),
        ),
      );
      await repository.enqueue(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, {
            ...context,
            eventId: randomUUID(),
          }),
        ),
      );
    });
    return toWalletView(wallet);
  }

  async get(walletId: string): Promise<WalletView> {
    if (!isUuid(walletId)) {
      throw new InvalidWalletInputError("Wallet ID must be a UUID");
    }
    return this.unitOfWork.execute(async (repository) => {
      const wallet = await repository.findById(walletId);
      if (!wallet) throw new WalletNotFoundError("Wallet was not found");
      return toWalletView(wallet);
    });
  }
}

export function validateCreateWalletInput(input: unknown): {
  playerId: string;
  initialBalance: Money;
} {
  if (!isRecord(input))
    throw new InvalidWalletInputError("Request body must be an object");
  assertExactKeys(input, ["playerId", "initialBalance"]);
  if (
    typeof input.playerId !== "string" ||
    input.playerId.trim().length === 0
  ) {
    throw new InvalidWalletInputError("Player ID is required");
  }
  if (!isRecord(input.initialBalance)) {
    throw new InvalidWalletInputError("Initial balance is required");
  }
  assertExactKeys(input.initialBalance, ["amount", "currency"]);
  if (typeof input.initialBalance.currency !== "string") {
    throw new InvalidWalletInputError("Currency must be a string");
  }
  if (input.initialBalance.currency !== "BRL") {
    throw new UnsupportedWalletCurrencyError("Only BRL wallets are available");
  }
  try {
    const initialBalance = Money.from(input.initialBalance);
    return { playerId: input.playerId, initialBalance };
  } catch (error: unknown) {
    if (error instanceof MoneyError) {
      throw new InvalidWalletInputError(error.message);
    }
    throw error;
  }
}

function isUuid(value: string): boolean {
  return (
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function assertExactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new InvalidWalletInputError("Unknown request fields are not allowed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
