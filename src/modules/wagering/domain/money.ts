export interface MoneyProps {
  amount: string;
  currency: string;
}

export class MoneyError extends Error {
  override name = "MoneyError";
}

export class Money {
  static readonly MAX_MINOR_UNITS = 100_000_000n;

  readonly #minorUnits: bigint;

  private constructor(
    minorUnits: bigint,
    public readonly currency: string,
  ) {
    if (currency !== "BRL" && currency !== "USD") {
      throw new MoneyError("Unsupported currency");
    }
    if (
      minorUnits < -Money.MAX_MINOR_UNITS ||
      minorUnits > Money.MAX_MINOR_UNITS
    ) {
      throw new MoneyError("Amount exceeds the supported range");
    }
    this.#minorUnits = minorUnits;
    Object.freeze(this);
  }

  static from(props: unknown): Money {
    if (
      typeof props !== "object" ||
      props === null ||
      Array.isArray(props) ||
      !("amount" in props) ||
      !("currency" in props)
    ) {
      throw new MoneyError("Amount and currency are required");
    }
    const { amount, currency } = props;
    if (
      typeof amount !== "string" ||
      amount.trim() !== amount ||
      !/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(amount)
    ) {
      throw new MoneyError(
        "Amount must be a non-negative decimal string with exactly two decimal places",
      );
    }
    if (typeof currency !== "string") {
      throw new MoneyError("Unsupported currency");
    }
    return new Money(BigInt(amount.replace(".", "")), currency);
  }

  static zero(currency: unknown): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#minorUnits + other.#minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#minorUnits - other.#minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.#minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.#minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.#minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.#minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#minorUnits < other.#minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#minorUnits === other.#minorUnits;
  }

  toJSON(): MoneyProps {
    const magnitude =
      this.#minorUnits < 0n ? -this.#minorUnits : this.#minorUnits;
    const sign = this.isNegative() ? "-" : "";
    const amount = `${sign}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
    return { amount, currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError("Currency mismatch");
    }
  }
}
