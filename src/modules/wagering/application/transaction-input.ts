import { createHash } from "node:crypto";
import { Money, MoneyError } from "../domain/money.ts";

export class TransactionApplicationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export interface BetInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: "BET";
  money: { amount: string; currency: string };
}
export function invalidTransaction(): never {
  throw new TransactionApplicationError(
    "INVALID_TRANSACTION_INPUT",
    400,
    "Transaction input is invalid",
  );
}
export function isUuid(value: string): boolean {
  return (
    value.length === 36 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  );
}
export function validateBet(
  input: unknown,
  key: unknown,
): { input: BetInput; money: Money; key: string; hash: string } {
  if (!isRecord(input) || typeof key !== "string" || !key.trim())
    invalidTransaction();
  const fields = [
    "providerId",
    "externalTransactionId",
    "playerId",
    "walletId",
    "roundId",
    "gameId",
    "kind",
    "money",
  ];
  if (Object.keys(input).some((k) => !fields.includes(k))) invalidTransaction();
  for (const field of fields.filter((k) => k !== "money"))
    if (typeof input[field] !== "string" || !input[field].trim())
      invalidTransaction();
  if (
    input.kind !== "BET" ||
    !isUuid(String(input.walletId)) ||
    !isRecord(input.money)
  )
    invalidTransaction();
  if (Object.keys(input.money).some((k) => !["amount", "currency"].includes(k)))
    invalidTransaction();
  if (typeof input.money.currency !== "string") invalidTransaction();
  if (input.money.currency !== "BRL")
    throw new TransactionApplicationError(
      "UNSUPPORTED_CURRENCY",
      400,
      "Only BRL is available",
    );
  let money: Money;
  try {
    money = Money.from(input.money);
  } catch (error: unknown) {
    if (error instanceof MoneyError) invalidTransaction();
    throw error;
  }
  if (!money.isPositive()) invalidTransaction();
  const validated: BetInput = {
    providerId: String(input.providerId),
    externalTransactionId: String(input.externalTransactionId),
    playerId: String(input.playerId),
    walletId: String(input.walletId).toLowerCase(),
    roundId: String(input.roundId),
    gameId: String(input.gameId),
    kind: "BET",
    money: money.toJSON(),
  };
  return {
    input: validated,
    money,
    key,
    hash: createHash("sha256").update(canonicalJson(validated)).digest("hex"),
  };
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
