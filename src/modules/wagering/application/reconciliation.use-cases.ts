import {
  InvalidWalletInputError,
  WalletNotFoundError,
} from "./wallet.errors.ts";

export interface ReconciliationSnapshot {
  readonly storedMinorUnits: bigint;
  readonly calculatedMinorUnits: bigint;
  readonly currency: string;
  readonly checkedEntries: bigint;
}

export interface ReconciliationReader {
  read(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface ReconciliationObservation {
  readonly correlationId: string;
  readonly walletId: string;
  readonly result: "consistent" | "mismatch";
  readonly checkedEntries: number;
}

export interface ReconciliationObserver {
  record(observation: ReconciliationObservation): void;
}

export class ReconciliationUseCases {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly observer: ReconciliationObserver,
  ) {}

  async reconcile(walletId: unknown, correlationId: string) {
    if (
      typeof walletId !== "string" ||
      walletId.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        walletId,
      )
    )
      throw new InvalidWalletInputError("Wallet ID must be a UUID");
    const normalizedId = walletId.toLowerCase();
    const snapshot = await this.reader.read(normalizedId);
    if (!snapshot) throw new WalletNotFoundError("Wallet was not found");
    if (
      snapshot.checkedEntries < 0n ||
      snapshot.checkedEntries > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error(
        "Reconciliation entry count is outside the safe integer range",
      );
    const checkedEntries = Number(snapshot.checkedEntries);
    const difference =
      snapshot.storedMinorUnits - snapshot.calculatedMinorUnits;
    const consistent = difference === 0n;
    const money = (minorUnits: bigint) => ({
      amount: formatDiagnosticAmount(minorUnits),
      currency: snapshot.currency,
    });
    const result = {
      walletId: normalizedId,
      storedBalance: money(snapshot.storedMinorUnits),
      calculatedBalance: money(snapshot.calculatedMinorUnits),
      difference: money(difference),
      consistent,
      checkedEntries,
    };
    this.observer.record({
      correlationId,
      walletId: normalizedId,
      result: consistent ? "consistent" : "mismatch",
      checkedEntries,
    });
    return result;
  }
}

// Diagnostic sums may exceed Money's operational range, including negative balances.
function formatDiagnosticAmount(minorUnits: bigint): string {
  const magnitude = minorUnits < 0n ? -minorUnits : minorUnits;
  return `${minorUnits < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}
