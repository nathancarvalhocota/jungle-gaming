import { defineEntity, type InferEntity, p } from "@mikro-orm/core";

export const WalletSchema = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.text().fieldName("player_id"),
    currency: p.string().length(3),
    balanceMinorUnits: p.bigint().fieldName("balance_minor_units"),
    version: p.integer(),
    createdAt: p.datetime().fieldName("created_at"),
    updatedAt: p.datetime().fieldName("updated_at"),
  },
  uniques: [
    {
      name: "wallets_player_currency_unique",
      properties: ["playerId", "currency"],
    },
  ],
  checks: [
    {
      name: "wallets_balance_nonnegative",
      expression: "balance_minor_units >= 0",
    },
    {
      name: "wallets_balance_max",
      expression: "balance_minor_units <= 100000000",
    },
    { name: "wallets_version_positive", expression: "version >= 1" },
    {
      name: "wallets_currency_supported",
      expression: "currency in ('BRL', 'USD')",
    },
  ],
});

export type WalletRecord = InferEntity<typeof WalletSchema>;
