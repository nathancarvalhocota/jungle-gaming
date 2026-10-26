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
export type ExternalTransactionKind =
  | WagerTransactionKind.Bet
  | WagerTransactionKind.Win
  | WagerTransactionKind.Loss
  | WagerTransactionKind.Refund;
export type CreateExternalProps = CreateBetProps & {
  kind: ExternalTransactionKind;
  referenceExternalTransactionId?: string;
};
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReferenceKindMismatch = "REFERENCE_KIND_MISMATCH",
  ReferenceContextMismatch = "REFERENCE_CONTEXT_MISMATCH",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  BalanceLimitExceeded = "BALANCE_LIMIT_EXCEEDED",
}

export interface WagerTransactionState {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  origin: "INTERNAL" | "EXTERNAL";
  kind: WagerTransactionKind.Opening | ExternalTransactionKind;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  external?: ExternalTransactionIdentity;
  failureCode?: FailureCode;
  status:
    | WagerTransactionStatus.Pending
    | WagerTransactionStatus.PendingReference
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
  readonly referenceExternalTransactionId: string | undefined;
  #referenceTransactionId: string | undefined;
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
      [
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Loss,
        WagerTransactionKind.Refund,
      ].includes(state.kind) &&
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
    if (
      !(state.money instanceof Money) ||
      state.money.isNegative() ||
      (state.kind !== WagerTransactionKind.Loss && !state.money.isPositive())
    )
      throw new WagerTransactionError("Invalid transaction money");
    if (
      state.referenceExternalTransactionId !== undefined &&
      (typeof state.referenceExternalTransactionId !== "string" ||
        !state.referenceExternalTransactionId.trim() ||
        ![
          WagerTransactionKind.Win,
          WagerTransactionKind.Loss,
          WagerTransactionKind.Refund,
        ].includes(state.kind))
    )
      throw new WagerTransactionError("Invalid external reference");
    if (
      state.kind === WagerTransactionKind.Refund &&
      !state.referenceExternalTransactionId
    )
      throw new WagerTransactionError("Refund requires a reference");
    if (
      state.referenceTransactionId !== undefined &&
      (typeof state.referenceTransactionId !== "string" ||
        !state.referenceTransactionId.trim() ||
        !state.referenceExternalTransactionId ||
        state.referenceTransactionId === state.id)
    )
      throw new WagerTransactionError("Invalid resolved reference");
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
          !validRejection(
            state.kind,
            state.failureCode,
            state.money,
            state.balance,
            state.referenceExternalTransactionId,
          )
        )
          throw new WagerTransactionError("Invalid transaction rejection");
      } else if (state.failureCode !== undefined)
        throw new WagerTransactionError("Processed transaction has no failure");
      if (
        state.status === WagerTransactionStatus.Processed &&
        state.referenceExternalTransactionId &&
        !state.referenceTransactionId
      )
        throw new WagerTransactionError("Processed reference must be resolved");
    } else if (state.status === WagerTransactionStatus.PendingReference) {
      if (
        !state.referenceExternalTransactionId ||
        !(state.balance instanceof Money) ||
        state.balance.isNegative() ||
        state.balance.currency !== state.money.currency ||
        state.processedAt !== undefined ||
        state.failureCode !== undefined
      )
        throw new WagerTransactionError("Invalid pending reference result");
    } else if (
      state.status !== WagerTransactionStatus.Pending ||
      state.balance !== undefined ||
      state.processedAt !== undefined ||
      state.referenceTransactionId !== undefined ||
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
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.#referenceTransactionId = state.referenceTransactionId;
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
    return WagerTransaction.createExternal({
      ...props,
      kind: WagerTransactionKind.Bet,
    });
  }

  static createExternal(props: CreateExternalProps): WagerTransaction {
    return new WagerTransaction({
      ...props,
      origin: "EXTERNAL",
      kind: props.kind,
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

  markProcessed(
    balance: Money,
    at: Date,
    referenceTransactionId?: string,
  ): void {
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
    this.assertReference(referenceTransactionId, true);
    this.#referenceTransactionId = referenceTransactionId;
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
  reject(
    code: FailureCode,
    balance: Money,
    at: Date,
    referenceTransactionId?: string,
  ): void {
    if (this.isTerminal())
      throw new InvalidTransactionStateError(
        "A terminal transaction cannot transition",
      );
    assertDate(at);
    if (
      !(balance instanceof Money) ||
      balance.isNegative() ||
      balance.currency !== this.money.currency ||
      !validRejection(
        this.kind,
        code,
        this.money,
        balance,
        this.referenceExternalTransactionId,
      )
    )
      throw new WagerTransactionError("Invalid transaction rejection");
    this.assertReference(referenceTransactionId, false);
    this.#referenceTransactionId = referenceTransactionId;
    this.#status = WagerTransactionStatus.Rejected;
    this.#failureCode = code;
    this.#balance = balance;
    this.#processedAt = at.getTime();
  }
  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }
  markPendingReference(balance: Money, referenceTransactionId?: string): void {
    if (this.isTerminal())
      throw new InvalidTransactionStateError(
        "A terminal transaction cannot transition",
      );
    if (
      !this.referenceExternalTransactionId ||
      !(balance instanceof Money) ||
      balance.isNegative() ||
      balance.currency !== this.money.currency
    )
      throw new WagerTransactionError("Invalid pending reference result");
    this.assertReference(referenceTransactionId, false);
    this.#status = WagerTransactionStatus.PendingReference;
    this.#balance = balance;
    this.#referenceTransactionId = referenceTransactionId;
  }
  referenceFailure(reference: WagerTransaction): FailureCode | undefined {
    if (
      this.referenceExternalTransactionId !== reference.externalTransactionId ||
      this.id === reference.id ||
      this.providerId !== reference.providerId ||
      this.playerId !== reference.playerId ||
      this.walletId !== reference.walletId ||
      this.money.currency !== reference.money.currency ||
      this.roundId !== reference.roundId
    )
      return FailureCode.ReferenceContextMismatch;
    if (reference.kind !== WagerTransactionKind.Bet)
      return FailureCode.ReferenceKindMismatch;
    if (reference.status === WagerTransactionStatus.Rejected)
      return FailureCode.ReferenceNotProcessed;
    if (
      this.kind === WagerTransactionKind.Refund &&
      reference.status === WagerTransactionStatus.Processed &&
      !this.money.equals(reference.money)
    )
      return FailureCode.ReferenceAmountMismatch;
    return undefined;
  }
  private assertReference(id: string | undefined, processed: boolean): void {
    if (
      (id !== undefined &&
        (typeof id !== "string" ||
          !id.trim() ||
          id === this.id ||
          !this.referenceExternalTransactionId)) ||
      (processed &&
        this.referenceExternalTransactionId !== undefined &&
        id === undefined)
    )
      throw new WagerTransactionError("Invalid resolved reference");
  }
  get referenceTransactionId(): string | undefined {
    return this.#referenceTransactionId;
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

function validRejection(
  kind: WagerTransactionState["kind"],
  code: FailureCode | undefined,
  money: Money,
  balance: Money,
  reference: string | undefined,
): boolean {
  if (kind === WagerTransactionKind.Bet)
    return code === FailureCode.InsufficientFunds && balance.isLessThan(money);
  if (
    kind !== WagerTransactionKind.Win &&
    kind !== WagerTransactionKind.Loss &&
    kind !== WagerTransactionKind.Refund
  )
    return false;
  if (code === FailureCode.BalanceLimitExceeded)
    return (
      (kind === WagerTransactionKind.Win ||
        kind === WagerTransactionKind.Refund) &&
      BigInt(balance.toJSON().amount.replace(".", "")) +
        BigInt(money.toJSON().amount.replace(".", "")) >
        Money.MAX_MINOR_UNITS
    );
  return (
    reference !== undefined &&
    ((kind === WagerTransactionKind.Refund &&
      [
        FailureCode.ReferenceAmountMismatch,
        FailureCode.ReferenceAlreadyReversed,
      ].includes(code as FailureCode)) ||
      [
        FailureCode.ReferenceKindMismatch,
        FailureCode.ReferenceContextMismatch,
        FailureCode.ReferenceNotProcessed,
      ].includes(code as FailureCode))
  );
}

function assertDate(value: unknown): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new WagerTransactionError("A valid transaction date is required");
}
