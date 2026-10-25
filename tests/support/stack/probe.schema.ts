import { EntitySchema } from "@mikro-orm/core";

export interface ProbeRecord {
  id: string;
  exactValue: string;
}

export interface ProbeAudit {
  id: string;
  recordId: string;
}

export const ProbeRecordSchema = new EntitySchema<ProbeRecord>({
  name: "ProbeRecord",
  tableName: "stack_probe_record",
  properties: {
    id: { type: "uuid", primary: true },
    exactValue: { type: "decimal", precision: 30, scale: 2 },
  },
});

export const ProbeAuditSchema = new EntitySchema<ProbeAudit>({
  name: "ProbeAudit",
  tableName: "stack_probe_audit",
  properties: {
    id: { type: "uuid", primary: true },
    recordId: { type: "uuid" },
  },
});
