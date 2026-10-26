import { Money } from "../money.ts";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export interface WagerTransactionState {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  origin: "INTERNAL";
  kind: WagerTransactionKind.Opening;
  status: WagerTransactionStatus.Pending | WagerTransactionStatus.Processed;
  balance: Money | undefined;
  createdAt: Date;
  processedAt: Date | undefined;
}

export class InvalidTransactionStateError extends Error {
  override name = "InvalidTransactionStateError";
}

export class WagerTransactionError extends Error {
  override name = "WagerTransactionError";
}

export class WagerTransaction {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly origin = "INTERNAL";
  readonly kind: WagerTransactionKind.Opening = WagerTransactionKind.Opening;
  readonly money: Money;
  readonly #createdAt: number;
  #status: WagerTransactionState["status"];
  #balance: Money | undefined;
  #processedAt: number | undefined;

  private constructor(state: WagerTransactionState) {
    for (const id of [state.id, state.walletId, state.playerId]) {
      if (typeof id !== "string" || id.trim().length === 0)
        throw new WagerTransactionError("Transaction identifiers are required");
    }
    if (
      state.origin !== "INTERNAL" ||
      state.kind !== WagerTransactionKind.Opening
    )
      throw new WagerTransactionError("Only internal opening is supported");
    if (!(state.money instanceof Money) || !state.money.isPositive())
      throw new WagerTransactionError("Opening money must be positive");
    assertDate(state.createdAt);
    if (state.status === WagerTransactionStatus.Processed) {
      if (
        !(state.balance instanceof Money) ||
        !state.balance.equals(state.money)
      )
        throw new WagerTransactionError("Opening result must match its money");
      assertDate(state.processedAt);
    } else if (
      state.status !== WagerTransactionStatus.Pending ||
      state.balance !== undefined ||
      state.processedAt !== undefined
    ) {
      throw new WagerTransactionError("Invalid opening transaction state");
    }
    this.id = state.id;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.money = state.money;
    this.#status = state.status;
    this.#balance = state.balance;
    this.#createdAt = state.createdAt.getTime();
    this.#processedAt = state.processedAt?.getTime();
    Object.freeze(this);
  }

  static create(props: CreateOpeningProps): WagerTransaction {
    return new WagerTransaction({
      ...props,
      origin: "INTERNAL",
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Pending,
      balance: undefined,
      createdAt: props.at,
      processedAt: undefined,
    });
  }

  static createOpening(props: CreateOpeningProps): WagerTransaction {
    return WagerTransaction.create(props);
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  markProcessed(balance: Money, at: Date): void {
    if (this.isTerminal())
      throw new InvalidTransactionStateError(
        "A terminal transaction cannot transition",
      );
    assertDate(at);
    if (!(balance instanceof Money) || !balance.equals(this.money))
      throw new WagerTransactionError("Opening result must match its money");
    this.#balance = balance;
    this.#processedAt = at.getTime();
    this.#status = WagerTransactionStatus.Processed;
  }

  isTerminal(): boolean {
    return this.#status === WagerTransactionStatus.Processed;
  }
  get status(): WagerTransactionState["status"] {
    return this.#status;
  }
  get balance(): Money | undefined {
    return this.#balance;
  }
  get createdAt(): Date {
    return new Date(this.#createdAt);
  }
  get processedAt(): Date | undefined {
    return this.#processedAt === undefined
      ? undefined
      : new Date(this.#processedAt);
  }
}

function assertDate(value: unknown): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new WagerTransactionError("A valid transaction date is required");
}
