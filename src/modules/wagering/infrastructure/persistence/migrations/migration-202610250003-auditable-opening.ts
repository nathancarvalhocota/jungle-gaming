import { Migration } from "@mikro-orm/migrations";

export class Migration202610250003AuditableOpening extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      "alter table wallets add constraint wallets_identity_unique unique (id, player_id, currency)",
    );
    this.addSql(`create table wager_transactions (
      id uuid primary key,
      wallet_id uuid not null,
      player_id text not null,
      origin text not null,
      kind text not null,
      status text not null,
      currency varchar(3) not null,
      money_minor_units bigint not null,
      balance_minor_units bigint,
      created_at timestamptz not null,
      processed_at timestamptz,
      constraint transactions_wallet_identity_fk foreign key (wallet_id, player_id, currency) references wallets (id, player_id, currency),
      constraint transactions_ledger_identity_unique unique (id, wallet_id, currency, money_minor_units),
      constraint transactions_internal_opening check (origin = 'INTERNAL' and kind = 'OPENING'),
      constraint transactions_money_range check (money_minor_units > 0 and money_minor_units <= 100000000),
      constraint transactions_result_range check (balance_minor_units is null or balance_minor_units between 0 and 100000000),
      constraint transactions_opening_state check (
        (status = 'PENDING' and balance_minor_units is null and processed_at is null)
        or (status = 'PROCESSED' and balance_minor_units is not null and balance_minor_units = money_minor_units and processed_at is not null)
      )
    )`);
    this.addSql(`create table wallet_ledger_entries (
      id uuid primary key,
      wallet_id uuid not null,
      transaction_id uuid not null,
      direction text not null,
      currency varchar(3) not null,
      money_minor_units bigint not null,
      balance_before_minor_units bigint not null,
      balance_after_minor_units bigint not null,
      created_at timestamptz not null,
      constraint ledger_transaction_wallet_unique unique (transaction_id, wallet_id),
      constraint ledger_transaction_identity_fk foreign key (transaction_id, wallet_id, currency, money_minor_units) references wager_transactions (id, wallet_id, currency, money_minor_units),
      constraint ledger_money_range check (money_minor_units > 0 and money_minor_units <= 100000000),
      constraint ledger_before_range check (balance_before_minor_units between 0 and 100000000),
      constraint ledger_after_range check (balance_after_minor_units between 0 and 100000000),
      constraint ledger_arithmetic check (
        (direction = 'CREDIT' and balance_before_minor_units + money_minor_units = balance_after_minor_units)
        or (direction = 'DEBIT' and balance_before_minor_units - money_minor_units = balance_after_minor_units)
      )
    )`);
    this.addSql(`create function reject_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'Wallet ledger is immutable' using errcode = '55000';
      end;
    $$`);
    this.addSql(
      "create trigger ledger_immutable before update or delete or truncate on wallet_ledger_entries for each statement execute function reject_ledger_mutation()",
    );
    this.addSql(`create table outbox_messages (
      id uuid primary key,
      aggregate_id uuid not null,
      event_type text not null,
      payload jsonb not null,
      occurred_at timestamptz not null,
      attempts integer not null,
      next_attempt_at timestamptz,
      published_at timestamptz,
      constraint outbox_attempts_nonnegative check (attempts >= 0),
      constraint outbox_envelope check (coalesce((
        jsonb_typeof(payload) = 'object'
        and payload ?& array['eventId', 'aggregateId', 'eventType', 'version', 'correlationId', 'occurredAt', 'data']
        and payload->>'eventId' = id::text
        and payload->>'aggregateId' = aggregate_id::text
        and payload->>'eventType' = event_type
        and payload->>'version' = '1'
      ), false))
    )`);
  }

  override async down(): Promise<void> {
    this.addSql("drop table outbox_messages");
    this.addSql("drop trigger ledger_immutable on wallet_ledger_entries");
    this.addSql("drop function reject_ledger_mutation()");
    this.addSql("drop table wallet_ledger_entries");
    this.addSql("drop table wager_transactions");
    this.addSql("alter table wallets drop constraint wallets_identity_unique");
  }
}
