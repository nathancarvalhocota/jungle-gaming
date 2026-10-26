import { Migration } from "@mikro-orm/migrations";

export class Migration202610260007Rollback extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions drop constraint transactions_origin_identity, drop constraint transactions_reference_shape, drop constraint transactions_processing_state,
      add constraint transactions_origin_identity check (
        (origin = 'INTERNAL' and kind = 'OPENING' and provider_id is null and external_transaction_id is null and idempotency_key is null and payload_hash is null and round_id is null and game_id is null)
        or (origin = 'EXTERNAL' and kind in ('BET','WIN','LOSS','REFUND','ROLLBACK') and coalesce(
          length(btrim(provider_id)) > 0 and length(btrim(external_transaction_id)) > 0
          and length(btrim(idempotency_key)) > 0 and payload_hash ~ '^[a-f0-9]{64}$'
          and length(btrim(round_id)) > 0 and length(btrim(game_id)) > 0, false))
      ),
      add constraint transactions_reference_shape check (
        (kind not in ('REFUND','ROLLBACK') and reference_external_transaction_id is null and reference_transaction_id is null)
        or (kind in ('WIN','LOSS','REFUND','ROLLBACK') and coalesce(length(btrim(reference_external_transaction_id)) > 0, false)
          and (reference_transaction_id is null or reference_transaction_id <> id))
      ),
      add constraint transactions_processing_state check (
        (status = 'PENDING' and balance_minor_units is null and processed_at is null and failure_code is null and reference_transaction_id is null)
        or (status = 'PENDING_REFERENCE' and kind in ('WIN','LOSS','REFUND','ROLLBACK') and reference_external_transaction_id is not null and balance_minor_units is not null and processed_at is null and failure_code is null)
        or (status = 'PROCESSED' and balance_minor_units is not null and processed_at is not null and failure_code is null
          and (kind <> 'OPENING' or balance_minor_units = money_minor_units) and (reference_external_transaction_id is null or reference_transaction_id is not null))
        or (status = 'REJECTED' and balance_minor_units is not null and processed_at is not null and coalesce(
          (kind = 'BET' and failure_code = 'INSUFFICIENT_FUNDS' and balance_minor_units < money_minor_units)
          or (kind in ('WIN','REFUND','ROLLBACK') and failure_code = 'BALANCE_LIMIT_EXCEEDED' and balance_minor_units + money_minor_units > 100000000)
          or (kind in ('WIN','LOSS','REFUND','ROLLBACK') and reference_external_transaction_id is not null and failure_code in ('REFERENCE_KIND_MISMATCH','REFERENCE_CONTEXT_MISMATCH','REFERENCE_NOT_PROCESSED'))
          or (kind = 'ROLLBACK' and failure_code = 'REVERSAL_INSUFFICIENT_FUNDS' and balance_minor_units < money_minor_units and reference_external_transaction_id is not null)
          or (kind in ('REFUND','ROLLBACK') and reference_external_transaction_id is not null and failure_code in ('REFERENCE_AMOUNT_MISMATCH','REFERENCE_ALREADY_REVERSED')), false))
      )`);
  }
  override async down(): Promise<void> {
    this.addSql(`alter table wager_transactions drop constraint transactions_origin_identity, drop constraint transactions_reference_shape, drop constraint transactions_processing_state,
      add constraint transactions_origin_identity check (
        (origin = 'INTERNAL' and kind = 'OPENING' and provider_id is null and external_transaction_id is null and idempotency_key is null and payload_hash is null and round_id is null and game_id is null)
        or (origin = 'EXTERNAL' and kind in ('BET','WIN','LOSS','REFUND') and coalesce(
          length(btrim(provider_id)) > 0 and length(btrim(external_transaction_id)) > 0
          and length(btrim(idempotency_key)) > 0 and payload_hash ~ '^[a-f0-9]{64}$'
          and length(btrim(round_id)) > 0 and length(btrim(game_id)) > 0, false))
      ),
      add constraint transactions_reference_shape check (
        (kind <> 'REFUND' and reference_external_transaction_id is null and reference_transaction_id is null)
        or (kind in ('WIN','LOSS','REFUND') and coalesce(length(btrim(reference_external_transaction_id)) > 0, false)
          and (reference_transaction_id is null or reference_transaction_id <> id))
      ),
      add constraint transactions_processing_state check (
        (status = 'PENDING' and balance_minor_units is null and processed_at is null and failure_code is null and reference_transaction_id is null)
        or (status = 'PENDING_REFERENCE' and kind in ('WIN','LOSS','REFUND') and reference_external_transaction_id is not null and balance_minor_units is not null and processed_at is null and failure_code is null)
        or (status = 'PROCESSED' and balance_minor_units is not null and processed_at is not null and failure_code is null
          and (kind <> 'OPENING' or balance_minor_units = money_minor_units) and (reference_external_transaction_id is null or reference_transaction_id is not null))
        or (status = 'REJECTED' and balance_minor_units is not null and processed_at is not null and coalesce(
          (kind = 'BET' and failure_code = 'INSUFFICIENT_FUNDS' and balance_minor_units < money_minor_units)
          or (kind in ('WIN','REFUND') and failure_code = 'BALANCE_LIMIT_EXCEEDED' and balance_minor_units + money_minor_units > 100000000)
          or (kind in ('WIN','LOSS','REFUND') and reference_external_transaction_id is not null and failure_code in ('REFERENCE_KIND_MISMATCH','REFERENCE_CONTEXT_MISMATCH','REFERENCE_NOT_PROCESSED'))
          or (kind = 'REFUND' and reference_external_transaction_id is not null and failure_code in ('REFERENCE_AMOUNT_MISMATCH','REFERENCE_ALREADY_REVERSED')), false))
      )`);
  }
}
