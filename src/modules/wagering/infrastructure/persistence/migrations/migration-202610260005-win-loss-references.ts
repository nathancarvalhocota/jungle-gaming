import { Migration } from "@mikro-orm/migrations";

export class Migration202610260005WinLossReferences extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions
      drop constraint transactions_origin_identity, drop constraint transactions_processing_state, drop constraint transactions_money_range,
      add column reference_external_transaction_id text, add column reference_transaction_id uuid,
      add constraint transactions_reference_identity_unique unique (id, provider_id, external_transaction_id, wallet_id, player_id, currency, round_id),
      add constraint transactions_reference_fk foreign key (reference_transaction_id, provider_id, reference_external_transaction_id, wallet_id, player_id, currency, round_id)
        references wager_transactions (id, provider_id, external_transaction_id, wallet_id, player_id, currency, round_id),
      add constraint transactions_origin_identity check (
        (origin = 'INTERNAL' and kind = 'OPENING' and provider_id is null and external_transaction_id is null and idempotency_key is null and payload_hash is null and round_id is null and game_id is null)
        or (origin = 'EXTERNAL' and kind in ('BET','WIN','LOSS') and coalesce(
          length(btrim(provider_id)) > 0 and length(btrim(external_transaction_id)) > 0
          and length(btrim(idempotency_key)) > 0 and payload_hash ~ '^[a-f0-9]{64}$'
          and length(btrim(round_id)) > 0 and length(btrim(game_id)) > 0, false))
      ),
      add constraint transactions_money_range check (money_minor_units between 0 and 100000000 and (kind = 'LOSS' or money_minor_units > 0)),
      add constraint transactions_reference_shape check (
        (reference_external_transaction_id is null and reference_transaction_id is null)
        or (kind in ('WIN','LOSS') and coalesce(length(btrim(reference_external_transaction_id)) > 0, false)
          and (reference_transaction_id is null or reference_transaction_id <> id))
      ),
      add constraint transactions_processing_state check (
        (status = 'PENDING' and balance_minor_units is null and processed_at is null and failure_code is null and reference_transaction_id is null)
        or (status = 'PENDING_REFERENCE' and kind in ('WIN','LOSS') and reference_external_transaction_id is not null and balance_minor_units is not null and processed_at is null and failure_code is null)
        or (status = 'PROCESSED' and balance_minor_units is not null and processed_at is not null and failure_code is null
          and (kind <> 'OPENING' or balance_minor_units = money_minor_units) and (reference_external_transaction_id is null or reference_transaction_id is not null))
        or (status = 'REJECTED' and balance_minor_units is not null and processed_at is not null and coalesce(
          (kind = 'BET' and failure_code = 'INSUFFICIENT_FUNDS' and balance_minor_units < money_minor_units)
          or (kind = 'WIN' and failure_code = 'BALANCE_LIMIT_EXCEEDED' and balance_minor_units + money_minor_units > 100000000)
          or (kind in ('WIN','LOSS') and reference_external_transaction_id is not null and failure_code in ('REFERENCE_KIND_MISMATCH','REFERENCE_CONTEXT_MISMATCH','REFERENCE_NOT_PROCESSED')), false))
      )`);
  }
  override async down(): Promise<void> {
    this.addSql(`alter table wager_transactions
      drop constraint transactions_reference_fk, drop constraint transactions_reference_identity_unique,
      drop constraint transactions_reference_shape, drop constraint transactions_origin_identity,
      drop constraint transactions_processing_state, drop constraint transactions_money_range,
      drop column reference_transaction_id, drop column reference_external_transaction_id,
      add constraint transactions_origin_identity check (
        (origin = 'INTERNAL' and kind = 'OPENING' and provider_id is null and external_transaction_id is null and idempotency_key is null and payload_hash is null and round_id is null and game_id is null)
        or (origin = 'EXTERNAL' and kind = 'BET' and coalesce(
          length(btrim(provider_id)) > 0 and length(btrim(external_transaction_id)) > 0
          and length(btrim(idempotency_key)) > 0 and payload_hash ~ '^[a-f0-9]{64}$'
          and length(btrim(round_id)) > 0 and length(btrim(game_id)) > 0, false))
      ),
      add constraint transactions_money_range check (money_minor_units > 0 and money_minor_units <= 100000000),
      add constraint transactions_processing_state check (
        (status = 'PENDING' and balance_minor_units is null and processed_at is null and failure_code is null)
        or (status = 'PROCESSED' and balance_minor_units is not null and processed_at is not null and failure_code is null and (kind <> 'OPENING' or balance_minor_units = money_minor_units))
        or (status = 'REJECTED' and kind = 'BET' and balance_minor_units is not null and processed_at is not null and coalesce(failure_code = 'INSUFFICIENT_FUNDS', false) and balance_minor_units < money_minor_units)
      )`);
  }
}
