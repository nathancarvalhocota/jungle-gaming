import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../ledger/wallet-ledger-entry.ts";
import { Money } from "../money.ts";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
}

export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class WalletError extends Error {
  override name = "WalletError";
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  #balance: Money;
  #version: number;
  readonly #createdAt: number;
  #updatedAt: number;

  private constructor(state: WalletState) {
    for (const id of [state.id, state.playerId]) {
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new WalletError("Wallet and player identifiers are required");
      }
    }
    if (!(state.balance instanceof Money) || state.balance.isNegative()) {
      throw new WalletError("Wallet balance must be non-negative Money");
    }
    if (state.currency !== state.balance.currency) {
      throw new WalletError("Wallet and balance currencies must match");
    }
    if (!Number.isSafeInteger(state.version) || state.version < 1) {
      throw new WalletError("Wallet version must be a positive safe integer");
    }
    for (const date of [state.createdAt, state.updatedAt]) {
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        throw new WalletError("Valid wallet dates are required");
      }
    }
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this.#balance = state.balance;
    this.#version = state.version;
    this.#createdAt = state.createdAt.getTime();
    this.#updatedAt = state.updatedAt.getTime();
    Object.freeze(this);
  }

  static open(props: OpenWalletProps): Wallet {
    if (!(props.initialBalance instanceof Money)) {
      throw new WalletError("Initial balance must be Money");
    }
    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: props.at,
      updatedAt: props.at,
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    return this.move(props, LedgerDirection.Debit);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    return this.move(props, LedgerDirection.Credit);
  }

  private move(
    props: WalletMovementProps,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    if (!(props.money instanceof Money) || !props.money.isPositive()) {
      throw new WalletError("Movement amount must be positive Money");
    }
    if (props.money.currency !== this.currency) {
      throw new WalletError("Movement and wallet currencies must match");
    }
    if (
      direction === LedgerDirection.Debit &&
      this.#balance.isLessThan(props.money)
    ) {
      throw new WalletError("Insufficient balance");
    }
    const version = this.#version + 1;
    if (!Number.isSafeInteger(version)) {
      throw new WalletError("Wallet version exceeds the supported range");
    }
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? this.#balance.subtract(props.money)
        : this.#balance.add(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this.#balance,
      balanceAfter,
      createdAt: props.at,
    });
    const updatedAt = entry.createdAt.getTime();
    this.#balance = balanceAfter;
    this.#version = version;
    this.#updatedAt = updatedAt;
    return entry;
  }

  get balance(): Money {
    return this.#balance;
  }

  get version(): number {
    return this.#version;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt);
  }
}
