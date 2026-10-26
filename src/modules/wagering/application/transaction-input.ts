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
export interface TransactionInput extends Omit<BetInput, "kind"> {
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  referenceExternalTransactionId?: string;
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
  const validated = validateTransaction(input, key);
  if (validated.input.kind !== "BET") invalidTransaction();
  return { ...validated, input: { ...validated.input, kind: "BET" } };
}
export function validateTransaction(
  input: unknown,
  key: unknown,
): { input: TransactionInput; money: Money; key: string; hash: string } {
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
  if (
    Object.keys(input).some(
      (k) => ![...fields, "referenceExternalTransactionId"].includes(k),
    )
  )
    invalidTransaction();
  for (const field of fields.filter((k) => k !== "money"))
    if (typeof input[field] !== "string" || !input[field].trim())
      invalidTransaction();
  if (
    !["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"].includes(
      String(input.kind),
    ) ||
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
  if (input.kind !== "LOSS" && !money.isPositive()) invalidTransaction();
  const hasReference = Object.hasOwn(input, "referenceExternalTransactionId");
  if (["REFUND", "ROLLBACK"].includes(String(input.kind)) && !hasReference)
    invalidTransaction();
  if (
    hasReference &&
    (input.kind === "BET" ||
      typeof input.referenceExternalTransactionId !== "string" ||
      !input.referenceExternalTransactionId.trim())
  )
    invalidTransaction();
  const validated: TransactionInput = {
    providerId: String(input.providerId),
    externalTransactionId: String(input.externalTransactionId),
    playerId: String(input.playerId),
    walletId: String(input.walletId).toLowerCase(),
    roundId: String(input.roundId),
    gameId: String(input.gameId),
    kind: input.kind as TransactionInput["kind"],
    money: money.toJSON(),
    ...(hasReference
      ? {
          referenceExternalTransactionId: String(
            input.referenceExternalTransactionId,
          ),
        }
      : {}),
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
