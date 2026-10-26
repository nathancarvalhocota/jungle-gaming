import { Controller, Get, Header, Inject } from "@nestjs/common";
import { ProcessReconciliationObserver } from "../infrastructure/reconciliation.observer.ts";

@Controller("metrics")
export class ReconciliationMetricsController {
  constructor(
    @Inject(ProcessReconciliationObserver)
    private readonly observer: ProcessReconciliationObserver,
  ) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  get() {
    return this.observer.metrics();
  }
}
