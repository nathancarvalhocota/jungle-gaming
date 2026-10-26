import { freezeJson, type IntegrationEvent } from "./integration-event.ts";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
  readonly #occurredAt: number;
  readonly #nextAttemptAt: number | undefined;
  readonly #publishedAt: number | undefined;

  private constructor(state: OutboxMessageState) {
    if (
      !(state.occurredAt instanceof Date) ||
      Number.isNaN(state.occurredAt.getTime())
    )
      throw new Error("A valid outbox date is required");
    for (const value of [state.id, state.aggregateId, state.eventType]) {
      if (typeof value !== "string" || value.trim().length === 0)
        throw new Error("Outbox identifiers are required");
    }
    for (const value of [
      state.occurredAt,
      state.nextAttemptAt,
      state.publishedAt,
    ]) {
      if (
        value !== undefined &&
        (!(value instanceof Date) || Number.isNaN(value.getTime()))
      )
        throw new Error("A valid outbox date is required");
    }
    if (!Number.isSafeInteger(state.attempts) || state.attempts < 0)
      throw new Error("Outbox attempts must be non-negative");
    if (
      state.payload.eventId !== state.id ||
      state.payload.aggregateId !== state.aggregateId ||
      state.payload.eventType !== state.eventType ||
      state.payload.occurredAt !== state.occurredAt.toISOString()
    )
      throw new Error("Outbox envelope must match its metadata");
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = freezeJson(structuredClone(state.payload));
    this.attempts = state.attempts;
    this.#occurredAt = state.occurredAt.getTime();
    this.#nextAttemptAt = state.nextAttemptAt?.getTime();
    this.#publishedAt = state.publishedAt?.getTime();
    Object.freeze(this);
  }

  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: undefined,
      publishedAt: undefined,
    });
  }
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }
  isPending(): boolean {
    return this.#publishedAt === undefined;
  }
  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }
  get nextAttemptAt(): Date | undefined {
    return this.#nextAttemptAt === undefined
      ? undefined
      : new Date(this.#nextAttemptAt);
  }
  get publishedAt(): Date | undefined {
    return this.#publishedAt === undefined
      ? undefined
      : new Date(this.#publishedAt);
  }
}
