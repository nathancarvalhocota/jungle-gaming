import { Migration } from "@mikro-orm/migrations";

export class Migration202610260008LedgerPagination extends Migration {
  override up(): void {
    this.addSql(
      "create index ledger_wallet_created_id_idx on wallet_ledger_entries (wallet_id, created_at, id)",
    );
  }

  override down(): void {
    this.addSql("drop index ledger_wallet_created_id_idx");
  }
}
