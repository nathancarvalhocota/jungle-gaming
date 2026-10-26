import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  ReconciliationReader,
  ReconciliationSnapshot,
} from "../../application/reconciliation.use-cases.ts";

export class MikroOrmReconciliationReader implements ReconciliationReader {
  constructor(private readonly em: EntityManager) {}

  async read(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    // A single command observes the wallet and its ledger at the same MVCC snapshot.
    const [row] = await this.em.fork().execute<
      {
        stored: string;
        calculated: string;
        currency: string;
        entries: string;
      }[]
    >(
      `select w.balance_minor_units::text as stored, w.currency,
        coalesce(sum(case e.direction when 'CREDIT' then e.money_minor_units else -e.money_minor_units end), 0)::text as calculated,
        count(e.id)::text as entries
      from wallets w
      left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ?
      group by w.id`,
      [walletId],
    );
    if (!row) return undefined;
    return {
      storedMinorUnits: BigInt(row.stored),
      calculatedMinorUnits: BigInt(row.calculated),
      currency: row.currency,
      checkedEntries: BigInt(row.entries),
    };
  }
}
