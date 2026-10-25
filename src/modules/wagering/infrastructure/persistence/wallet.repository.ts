import type { EntityManager } from "@mikro-orm/postgresql";
import { WalletAlreadyExistsError } from "../../application/wallet.errors.ts";
import { Money } from "../../domain/money.ts";
import { Wallet } from "../../domain/wallet/wallet.ts";
import { type WalletRecord, WalletSchema } from "./wallet.schema.ts";

export class WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async create(wallet: Wallet): Promise<void> {
    const record = this.em.create(WalletSchema, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceMinorUnits: BigInt(
        wallet.balance.toJSON().amount.replace(".", ""),
      ),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    try {
      this.em.persist(record);
      await this.em.flush();
    } catch (error: unknown) {
      if (isWalletUniqueViolation(error)) {
        throw new WalletAlreadyExistsError(
          "A wallet already exists for this player and currency",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id });
    return record ? this.toDomain(record) : undefined;
  }

  private toDomain(record: WalletRecord): Wallet {
    const balance = Money.from({
      amount: formatMinorUnits(BigInt(record.balanceMinorUnits)),
      currency: record.currency,
    });
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}

function formatMinorUnits(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}

function isWalletUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (
    record.code === "23505" &&
    record.constraint === "wallets_player_currency_unique"
  ) {
    return true;
  }
  return "cause" in record && isWalletUniqueViolation(record.cause);
}
