import { Migration } from "@mikro-orm/migrations";

// This migration belongs only to the disposable stack validation database.
export class Migration202610250001StackProbe extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table stack_probe_record (
      id uuid primary key,
      exact_value numeric(30, 2) not null,
      constraint stack_probe_value_nonnegative check (exact_value >= 0)
    )`);
    this.addSql(`create table stack_probe_audit (
      id uuid primary key,
      record_id uuid not null references stack_probe_record(id)
    )`);
  }

  override async down(): Promise<void> {
    this.addSql("drop table stack_probe_audit");
    this.addSql("drop table stack_probe_record");
  }
}
