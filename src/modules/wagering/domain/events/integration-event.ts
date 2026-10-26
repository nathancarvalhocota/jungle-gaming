export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly #occurredAt: number;
  readonly #data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const id of [props.eventId, props.aggregateId, props.correlationId]) {
      if (typeof id !== "string" || id.trim().length === 0)
        throw new Error("Event identifiers are required");
    }
    if (
      !(props.occurredAt instanceof Date) ||
      Number.isNaN(props.occurredAt.getTime())
    )
      throw new Error("A valid event date is required");
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.#occurredAt = props.occurredAt.getTime();
    this.#data = freezeJson(structuredClone(props.data));
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }
  get data(): Readonly<T> {
    return this.#data;
  }
  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined
        ? {}
        : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.#data),
    };
  }
}

export function freezeJson<T>(value: T, ancestors = new Set<object>()): T {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object") {
    if (
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype) ||
      ancestors.has(value)
    )
      throw new Error("Event payload must contain only JSON values");
    ancestors.add(value);
    for (const item of Object.values(value)) freezeJson(item, ancestors);
    ancestors.delete(value);
    Object.freeze(value);
    return value;
  }
  throw new Error("Event payload must contain only JSON values");
}
