import type {
  ReconciliationObservation,
  ReconciliationObserver,
} from "../application/reconciliation.use-cases.ts";

export class ProcessReconciliationObserver implements ReconciliationObserver {
  private readonly counts = { consistent: 0n, mismatch: 0n };

  record(observation: ReconciliationObservation): void {
    this.counts[observation.result]++;
    if (observation.result === "mismatch")
      console.info(
        JSON.stringify({
          event: "wallet_reconciliation_mismatch",
          correlationId: observation.correlationId,
          walletId: observation.walletId,
          result: observation.result,
          checkedEntries: observation.checkedEntries,
        }),
      );
  }

  metrics(): string {
    return [
      "# HELP reconciliation_checks_total Completed wallet reconciliation checks in this process.",
      "# TYPE reconciliation_checks_total counter",
      `reconciliation_checks_total{result="consistent"} ${this.counts.consistent}`,
      `reconciliation_checks_total{result="mismatch"} ${this.counts.mismatch}`,
      "",
    ].join("\n");
  }
}
