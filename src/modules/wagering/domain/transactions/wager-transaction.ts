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

export interface ExternalTransactionIdentity {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  roundId: string;
  gameId: string;
}

export type CreateBetProps = CreateOpeningProps & ExternalTransactionIdentity;
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
}

export interface WagerTransactionState {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  origin: "INTERNAL" | "EXTERNAL";
  kind: WagerTransactionKind.Opening | WagerTransactionKind.Bet;
  external?: ExternalTransactionIdentity;
  failureCode?: FailureCode;
  status:
    | WagerTransactionStatus.Pending
    | WagerTransactionStatus.Processed
    | WagerTransactionStatus.Rejected;
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
  readonly origin: WagerTransactionState["origin"];
  readonly kind: WagerTransactionState["kind"];
  declare readonly providerId: string | undefined;
  declare readonly externalTransactionId: string | undefined;
  declare readonly idempotencyKey: string | undefined;
  declare readonly payloadHash: string | undefined;
  declare readonly roundId: string | undefined;
  declare readonly gameId: string | undefined;
  readonly money: Money;
  readonly #createdAt: number;
  #status: WagerTransactionState["status"];
  #balance: Money | undefined;
  #processedAt: number | undefined;
  #failureCode: FailureCode | undefined;

  private constructor(state: WagerTransactionState) {
    for (const id of [state.id, state.walletId, state.playerId]) {
      if (typeof id !== "string" || id.trim().length === 0)
        throw new WagerTransactionError("Transaction identifiers are required");
    }
    if (
      state.origin === "INTERNAL" &&
      state.kind === WagerTransactionKind.Opening
    ) {
      if (state.external !== undefined || state.failureCode !== undefined)
        throw new WagerTransactionError(
          "Opening has no external identity or rejection",
        );
    } else if (
      state.origin === "EXTERNAL" &&
      state.kind === WagerTransactionKind.Bet &&
      state.external
    ) {
      for (const field of [
        "providerId",
        "externalTransactionId",
        "idempotencyKey",
        "payloadHash",
        "roundId",
        "gameId",
      ] as const) {
        const value = state.external[field];
        if (typeof value !== "string" || value.trim().length === 0)
          throw new WagerTransactionError(
            "External transaction identity is required",
          );
      }
      if (
        state.external.payloadHash.length !== 64 ||
        !/^[a-f0-9]{64}$/.test(state.external.payloadHash)
      )
        throw new WagerTransactionError("Invalid payload hash");
      this.providerId = state.external.providerId;
      this.externalTransactionId = state.external.externalTransactionId;
      this.idempotencyKey = state.external.idempotencyKey;
      this.payloadHash = state.external.payloadHash;
      this.roundId = state.external.roundId;
      this.gameId = state.external.gameId;
    } else
      throw new WagerTransactionError(
        "Unsupported transaction origin and kind",
      );
    if (!(state.money instanceof Money) || !state.money.isPositive())
      throw new WagerTransactionError("Transaction money must be positive");
    assertDate(state.createdAt);
    if (
      state.status === WagerTransactionStatus.Processed ||
      state.status === WagerTransactionStatus.Rejected
    ) {
      if (
        !(state.balance instanceof Money) ||
        state.balance.isNegative() ||
        state.balance.currency !== state.money.currency ||
        (state.kind === WagerTransactionKind.Opening &&
          !state.balance.equals(state.money))
      )
        throw new WagerTransactionError("Invalid transaction result");
      assertDate(state.processedAt);
      if (state.status === WagerTransactionStatus.Rejected) {
        if (
          state.kind !== WagerTransactionKind.Bet ||
          state.failureCode !== FailureCode.InsufficientFunds ||
          !state.balance.isLessThan(state.money)
        )
          throw new WagerTransactionError("Invalid BET rejection");
      } else if (state.failureCode !== undefined)
        throw new WagerTransactionError("Processed transaction has no failure");
    } else if (
      state.status !== WagerTransactionStatus.Pending ||
      state.balance !== undefined ||
      state.processedAt !== undefined ||
      state.failureCode !== undefined
    ) {
      throw new WagerTransactionError("Invalid transaction state");
    }
    this.id = state.id;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.money = state.money;
    this.origin = state.origin;
    this.kind = state.kind;
    this.#status = state.status;
    this.#balance = state.balance;
    this.#createdAt = state.createdAt.getTime();
    this.#processedAt = state.processedAt?.getTime();
    this.#failureCode = state.failureCode;
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

  static createBet(props: CreateBetProps): WagerTransaction {
    return new WagerTransaction({
      ...props,
      origin: "EXTERNAL",
      kind: WagerTransactionKind.Bet,
      external: {
        providerId: props.providerId,
        externalTransactionId: props.externalTransactionId,
        idempotencyKey: props.idempotencyKey,
        payloadHash: props.payloadHash,
        roundId: props.roundId,
        gameId: props.gameId,
      },
      status: WagerTransactionStatus.Pending,
      balance: undefined,
      createdAt: props.at,
      processedAt: undefined,
    });
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
    if (
      !(balance instanceof Money) ||
      balance.isNegative() ||
      balance.currency !== this.money.currency ||
      (this.kind === WagerTransactionKind.Opening &&
        !balance.equals(this.money))
    )
      throw new WagerTransactionError("Invalid transaction result");
    this.#balance = balance;
    this.#processedAt = at.getTime();
    this.#status = WagerTransactionStatus.Processed;
  }

  isTerminal(): boolean {
    return (
      this.#status === WagerTransactionStatus.Processed ||
      this.#status === WagerTransactionStatus.Rejected
    );
  }
  reject(code: FailureCode, balance: Money, at: Date): void {
    if (this.isTerminal())
      throw new InvalidTransactionStateError(
        "A terminal transaction cannot transition",
      );
    assertDate(at);
    if (
      this.kind !== WagerTransactionKind.Bet ||
      code !== FailureCode.InsufficientFunds ||
      !(balance instanceof Money) ||
      balance.isNegative() ||
      balance.currency !== this.money.currency ||
      !balance.isLessThan(this.money)
    )
      throw new WagerTransactionError("Invalid BET rejection");
    this.#status = WagerTransactionStatus.Rejected;
    this.#failureCode = code;
    this.#balance = balance;
    this.#processedAt = at.getTime();
  }
  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }
  get failureCode(): FailureCode | undefined {
    return this.#failureCode;
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
