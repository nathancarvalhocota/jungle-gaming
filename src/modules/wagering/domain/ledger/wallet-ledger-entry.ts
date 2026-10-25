import { Money } from "../money.ts";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class LedgerEntryError extends Error {
  override name = "LedgerEntryError";
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly #createdAt: number;

  private constructor(state: LedgerEntryState) {
    for (const id of [state.id, state.walletId, state.transactionId]) {
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new LedgerEntryError("Ledger identifiers are required");
      }
    }
    if (
      state.direction !== LedgerDirection.Debit &&
      state.direction !== LedgerDirection.Credit
    ) {
      throw new LedgerEntryError("Invalid ledger direction");
    }
    for (const value of [
      state.money,
      state.balanceBefore,
      state.balanceAfter,
    ]) {
      if (!(value instanceof Money) || value.isNegative()) {
        throw new LedgerEntryError(
          "Ledger amounts must be non-negative Money values",
        );
      }
      if (value.currency !== state.money.currency) {
        throw new LedgerEntryError("Ledger currencies must match");
      }
    }
    if (
      !(state.createdAt instanceof Date) ||
      Number.isNaN(state.createdAt.getTime())
    ) {
      throw new LedgerEntryError("A valid creation date is required");
    }
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.#createdAt = state.createdAt.getTime();
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    if (props.money instanceof Money && props.money.isZero()) {
      throw new LedgerEntryError(
        "A new ledger entry must move a positive amount",
      );
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new LedgerEntryError("Ledger entry is not balanced");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  isBalanced(): boolean {
    const change = this.balanceAfter.subtract(this.balanceBefore);
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.money
        : this.money.negate();
    return change.equals(expected);
  }
}
