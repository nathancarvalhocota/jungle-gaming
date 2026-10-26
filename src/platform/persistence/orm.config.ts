import type { EntitySchema } from "@mikro-orm/core";
import { Migrator } from "@mikro-orm/migrations";
import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migration202610250002WalletZero } from "../../modules/wagering/infrastructure/persistence/migrations/migration-202610250002-wallet-zero.ts";
import { Migration202610250003AuditableOpening } from "../../modules/wagering/infrastructure/persistence/migrations/migration-202610250003-auditable-opening.ts";
import { Migration202610250004IdempotentBet } from "../../modules/wagering/infrastructure/persistence/migrations/migration-202610250004-idempotent-bet.ts";
import {
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
} from "../../modules/wagering/infrastructure/persistence/opening.schema.ts";
import { WalletSchema } from "../../modules/wagering/infrastructure/persistence/wallet.schema.ts";

export function createOrmOptions(): ReturnType<
  typeof defineConfig<PostgreSqlEntityManager, EntitySchema[]>
> {
  const clientUrl = process.env.DATABASE_URL;

  if (!clientUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const url = new URL(clientUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }

  return defineConfig<PostgreSqlEntityManager, EntitySchema[]>({
    clientUrl,
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      OutboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        Migration202610250002WalletZero,
        Migration202610250003AuditableOpening,
        Migration202610250004IdempotentBet,
      ],
      snapshot: false,
    },
  });
}
