import { Migration } from "@mikro-orm/migrations";

export class Migration202610250002WalletZero extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table wallets (
      id uuid primary key,
      player_id text not null,
      currency varchar(3) not null,
      balance_minor_units bigint not null,
      version integer not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      constraint wallets_player_currency_unique unique (player_id, currency),
      constraint wallets_balance_nonnegative check (balance_minor_units >= 0),
      constraint wallets_balance_max check (balance_minor_units <= 100000000),
      constraint wallets_version_positive check (version >= 1),
      constraint wallets_currency_supported check (currency in ('BRL', 'USD'))
    )`);
  }

  override async down(): Promise<void> {
    this.addSql("drop table wallets");
  }
}
