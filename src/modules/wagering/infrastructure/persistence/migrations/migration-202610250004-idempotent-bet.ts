import { Migration } from "@mikro-orm/migrations";
export class Migration202610250004IdempotentBet extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions
      drop constraint transactions_internal_opening, drop constraint transactions_opening_state,
      add column provider_id text, add column external_transaction_id text,
      add column idempotency_key text, add column payload_hash text,
      add column round_id text, add column game_id text, add column failure_code text,
      add constraint transactions_idempotency_key_unique unique (idempotency_key),
      add constraint transactions_external_identity_unique unique (provider_id, external_transaction_id),
      add constraint transactions_origin_identity check (
        (origin = 'INTERNAL' and kind = 'OPENING' and provider_id is null and external_transaction_id is null and idempotency_key is null and payload_hash is null and round_id is null and game_id is null)
        or (origin = 'EXTERNAL' and kind = 'BET' and coalesce(
          length(btrim(provider_id)) > 0 and length(btrim(external_transaction_id)) > 0
          and length(btrim(idempotency_key)) > 0 and payload_hash ~ '^[a-f0-9]{64}$'
          and length(btrim(round_id)) > 0 and length(btrim(game_id)) > 0, false))
      ),
      add constraint transactions_processing_state check (
        (status = 'PENDING' and balance_minor_units is null and processed_at is null and failure_code is null)
        or (status = 'PROCESSED' and balance_minor_units is not null and processed_at is not null and failure_code is null and (kind <> 'OPENING' or balance_minor_units = money_minor_units))
        or (status = 'REJECTED' and kind = 'BET' and balance_minor_units is not null and processed_at is not null and coalesce(failure_code = 'INSUFFICIENT_FUNDS', false) and balance_minor_units < money_minor_units)
      )`);
  }
  override async down(): Promise<void> {
    this.addSql(`alter table wager_transactions
      drop constraint transactions_origin_identity, drop constraint transactions_processing_state,
      drop constraint transactions_idempotency_key_unique, drop constraint transactions_external_identity_unique,
      drop column provider_id, drop column external_transaction_id, drop column idempotency_key,
      drop column payload_hash, drop column round_id, drop column game_id, drop column failure_code,
      add constraint transactions_internal_opening check (origin = 'INTERNAL' and kind = 'OPENING'),
      add constraint transactions_opening_state check (
        (status = 'PENDING' and balance_minor_units is null and processed_at is null)
        or (status = 'PROCESSED' and balance_minor_units is not null and balance_minor_units = money_minor_units and processed_at is not null)
      )`);
  }
}
