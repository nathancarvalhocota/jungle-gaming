import { describe, expect, test } from "bun:test";
import { Money, MoneyError } from "../../src/modules/wagering/domain/money.ts";

const money = (amount: string, currency = "BRL") =>
  Money.from({ amount, currency });

describe("Money construction", () => {
  test.each(["0.00", "0.01", "25.00", "1230.00", "999999.99", "1000000.00"])(
    "preserves the exact input string %s",
    (amount) => {
      for (const currency of ["BRL", "USD"]) {
        expect(money(amount, currency).toJSON()).toEqual({ amount, currency });
      }
    },
  );

  test.each(
    [
      25,
      0,
      -25,
      NaN,
      Infinity,
      -Infinity,
      25n,
      null,
      undefined,
      true,
      {},
      [],
      "25",
      "25.0",
      "25.000",
      "025.00",
      "00.00",
      "+25.00",
      "-0.00",
      "-25.00",
      "25,00",
      "1,230.00",
      "1.230,00",
      "1e2",
      "1e2.00",
      "NaN",
      "Infinity",
      "",
      " ",
      " 25.00",
      "25.00 ",
      "\n25.00",
      "25.00\n",
      "25.00\r\n",
      "\t25.00",
      "25.00\t",
      "2 5.00",
      "25.\n00",
      ".01",
      "1_000.00",
      "２５.００",
    ].map((value) => [value] as const),
  )("rejects invalid runtime amount %p", (amount) => {
    expect(() => Money.from({ amount, currency: "BRL" })).toThrow(MoneyError);
  });

  test.each(
    [
      null,
      undefined,
      25,
      "25.00",
      [],
      {},
      { amount: "25.00" },
      { currency: "BRL" },
    ].map((value) => [value] as const),
  )("rejects invalid props %p", (props) => {
    expect(() => Money.from(props)).toThrow(MoneyError);
  });

  test.each(
    [
      "XYZ",
      "brl",
      "usd",
      "",
      " BRL",
      "BRL\n",
      null,
      undefined,
      123,
      true,
      {},
      [],
    ].map((value) => [value] as const),
  )("rejects unsupported runtime currency %p in both factories", (currency) => {
    expect(() => Money.from({ amount: "0.00", currency })).toThrow(MoneyError);
    expect(() => Money.zero(currency)).toThrow(MoneyError);
  });

  test("rejects one cent above the inclusive limit without rounding", () => {
    expect(Money.MAX_MINOR_UNITS).toBe(100_000_000n);
    expect(() => money("1000000.01")).toThrow(MoneyError);
    expect(() => money("999999999999999999999999999999999999.99")).toThrow(
      MoneyError,
    );
  });
});

describe.each(["BRL", "USD"])("Money arithmetic in %s", (currency) => {
  test("adds decimal fractions exactly and preserves currency", () => {
    expect(
      money("0.10", currency).add(money("0.20", currency)).toJSON(),
    ).toEqual({
      amount: "0.30",
      currency,
    });
    expect(
      money("0.99", currency).add(money("0.01", currency)).toJSON().amount,
    ).toBe("1.00");
  });

  test("subtracts across whole units and creates exact signed results", () => {
    expect(
      money("1.00", currency).subtract(money("0.01", currency)).toJSON().amount,
    ).toBe("0.99");
    const negative = money("0.10", currency).subtract(money("0.20", currency));
    expect(negative.toJSON()).toEqual({ amount: "-0.10", currency });
    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
    expect(negative.isZero()).toBe(false);
    expect(negative.negate().toJSON().amount).toBe("0.10");
    expect(negative.add(money("0.20", currency)).toJSON().amount).toBe("0.10");
    expect(money("0.10", currency).subtract(negative).toJSON().amount).toBe(
      "0.20",
    );
  });

  test("zero is unsigned and neither positive nor negative", () => {
    const zero = Money.zero(currency);
    expect(zero.toJSON()).toEqual({ amount: "0.00", currency });
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(zero.negate().toJSON()).toEqual(zero.toJSON());
    expect(
      money("25.00", currency).subtract(money("25.00", currency)).equals(zero),
    ).toBe(true);
    expect(money("25.00", currency).add(zero).toJSON().amount).toBe("25.00");
  });

  test("compares signed amounts and equality by value", () => {
    const positive = money("0.01", currency);
    const negative = positive.negate();
    const zero = Money.zero(currency);
    expect(positive.isPositive()).toBe(true);
    expect(positive.isNegative()).toBe(false);
    expect(positive.isZero()).toBe(false);
    expect(negative.isLessThan(zero)).toBe(true);
    expect(zero.isLessThan(positive)).toBe(true);
    expect(positive.isLessThan(negative)).toBe(false);
    expect(positive.isLessThan(money("0.01", currency))).toBe(false);
    expect(positive.equals(money("0.01", currency))).toBe(true);
    expect(positive.equals(negative)).toBe(false);
    expect(negative.equals(money("0.00", currency).subtract(positive))).toBe(
      true,
    );
  });

  test("accepts both signed limits and arithmetic results at the limits", () => {
    const max = money("1000000.00", currency);
    const min = max.negate();
    const zero = Money.zero(currency);
    expect(min.toJSON()).toEqual({ amount: "-1000000.00", currency });
    expect(min.negate().equals(max)).toBe(true);
    expect(zero.subtract(max).equals(min)).toBe(true);
    expect(min.add(max).equals(zero)).toBe(true);
    expect(
      money("999999.99", currency).add(money("0.01", currency)).equals(max),
    ).toBe(true);
    expect(
      money("999999.99", currency)
        .negate()
        .subtract(money("0.01", currency))
        .equals(min),
    ).toBe(true);
    expect(max.add(zero).equals(max)).toBe(true);
    expect(min.subtract(zero).equals(min)).toBe(true);
  });

  test("rejects positive and negative overflow for both add and subtract without mutation", () => {
    const max = money("1000000.00", currency);
    const min = max.negate();
    const cent = money("0.01", currency);
    const negativeCent = cent.negate();
    const originals = [max, min, cent, negativeCent].map((value) =>
      value.toJSON(),
    );
    expect(() => max.add(cent)).toThrow(MoneyError);
    expect(() => min.add(negativeCent)).toThrow(MoneyError);
    expect(() => max.subtract(negativeCent)).toThrow(MoneyError);
    expect(() => min.subtract(cent)).toThrow(MoneyError);
    expect(() => max.subtract(min)).toThrow(MoneyError);
    expect(() => min.subtract(max)).toThrow(MoneyError);
    expect(
      [max, min, cent, negativeCent].map((value) => value.toJSON()),
    ).toEqual(originals);
  });
});

describe("Money currency conflicts", () => {
  test.each(["add", "subtract", "isLessThan", "equals"] as const)(
    "%s rejects BRL/USD even for identical amounts or zero",
    (operation) => {
      for (const amount of ["0.00", "25.00"]) {
        const brl = money(amount, "BRL");
        const usd = money(amount, "USD");
        const originals = [brl.toJSON(), usd.toJSON()];
        expect(() => brl[operation](usd)).toThrow(MoneyError);
        expect(() => usd[operation](brl)).toThrow(MoneyError);
        expect([brl.toJSON(), usd.toJSON()]).toEqual(originals);
      }
    },
  );
});

describe("Money serialization and immutability", () => {
  test("serializes stable plain string props without exposing bigint", () => {
    const value = money("25.00").negate();
    expect(value.toJSON()).toEqual({ amount: "-25.00", currency: "BRL" });
    expect(Object.getPrototypeOf(value.toJSON())).toBe(Object.prototype);
    expect(JSON.stringify(value)).toBe('{"amount":"-25.00","currency":"BRL"}');
    expect(JSON.stringify({ value })).toBe(
      '{"value":{"amount":"-25.00","currency":"BRL"}}',
    );
    expect(
      Money.from(JSON.parse(JSON.stringify(money("1230.00", "USD")))).toJSON(),
    ).toEqual({
      amount: "1230.00",
      currency: "USD",
    });
    expect(value.toString()).toBe("-25.00 BRL");
    expect(Money.zero("USD").toString()).toBe("0.00 USD");
    expect(() => Money.from(value.toJSON())).toThrow(MoneyError);
  });

  test("operations create new instances and leave operands and input/output objects independent", () => {
    const props = { amount: "25.00", currency: "BRL" };
    const value = Money.from(props);
    const other = money("0.10");
    props.amount = "99.00";
    props.currency = "USD";
    const output = value.toJSON();
    output.amount = "99.00";
    output.currency = "USD";
    expect(value.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(value.add(other)).not.toBe(value);
    expect(value.subtract(other)).not.toBe(value);
    expect(value.negate()).not.toBe(value);
    expect(Money.zero("BRL").negate().toJSON().amount).toBe("0.00");
    expect(value.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(other.toJSON()).toEqual({ amount: "0.10", currency: "BRL" });
    expect(Reflect.set(value, "currency", "USD")).toBe(false);
    expect(value.currency).toBe("BRL");
  });
});
