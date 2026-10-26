import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry.ts";
import {
  InvalidWalletInputError,
  WalletNotFoundError,
} from "./wallet.errors.ts";
import type { WalletRepositoryPort } from "./wallet-ports.ts";

export class InvalidLedgerQueryError extends Error {
  override name = "InvalidLedgerQueryError";
}

export interface LedgerRepositoryPort
  extends Pick<WalletRepositoryPort, "findById"> {
  listLedgerEntries(
    walletId: string,
    limit: number,
    entryId?: string,
  ): Promise<WalletLedgerEntry[] | undefined>;
}

export interface LedgerUnitOfWork {
  execute<T>(
    operation: (repository: LedgerRepositoryPort) => Promise<T>,
  ): Promise<T>;
}

export class LedgerUseCases {
  constructor(private readonly unitOfWork: LedgerUnitOfWork) {}

  async list(walletId: unknown, query: unknown) {
    if (!isUuid(walletId))
      throw new InvalidWalletInputError("Wallet ID must be a UUID");
    const normalizedId = walletId.toLowerCase();
    const { limit, entryId } = validateQuery(normalizedId, query);
    return this.unitOfWork.execute(async (repository) => {
      if (!(await repository.findById(normalizedId)))
        throw new WalletNotFoundError("Wallet was not found");
      const entries = await repository.listLedgerEntries(
        normalizedId,
        limit + 1,
        entryId,
      );
      if (!entries)
        throw new InvalidLedgerQueryError("Cursor anchor was not found");
      const items = entries.slice(0, limit).map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      }));
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          entries.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  v: 1,
                  walletId: normalizedId,
                  entryId: last.id,
                }),
              ).toString("base64url")
            : null,
      };
    });
  }
}

function validateQuery(
  walletId: string,
  query: unknown,
): { limit: number; entryId?: string } {
  if (
    !isRecord(query) ||
    Object.keys(query).some((key) => key !== "limit" && key !== "cursor")
  )
    invalid();
  let limit = 50;
  if (Object.hasOwn(query, "limit")) {
    if (
      typeof query.limit !== "string" ||
      !/^(?:[1-9][0-9]?|100)$/.test(query.limit) ||
      String(Number(query.limit)) !== query.limit
    )
      invalid();
    limit = Number(query.limit);
  }
  if (!Object.hasOwn(query, "cursor")) return { limit };
  const cursor = query.cursor;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return invalid();
  }
  if (
    !isRecord(decoded) ||
    Object.keys(decoded).length !== 3 ||
    decoded.v !== 1 ||
    !isUuid(decoded.walletId) ||
    !isUuid(decoded.entryId) ||
    decoded.walletId.toLowerCase() !== walletId
  )
    invalid();
  return { limit, entryId: decoded.entryId.toLowerCase() };
}

function invalid(): never {
  throw new InvalidLedgerQueryError("Ledger query is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
