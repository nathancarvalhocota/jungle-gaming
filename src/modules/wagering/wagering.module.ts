import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { LedgerUseCases } from "./application/ledger.use-cases.ts";
import { ReconciliationUseCases } from "./application/reconciliation.use-cases.ts";
import { TransactionUseCases } from "./application/transaction.use-cases.ts";
import { WalletUseCases } from "./application/wallet.use-cases.ts";
import { MikroOrmReconciliationReader } from "./infrastructure/persistence/reconciliation.reader.ts";
import { MikroOrmTransactionUnitOfWork } from "./infrastructure/persistence/transaction.repository.ts";
import { WalletSchema } from "./infrastructure/persistence/wallet.schema.ts";
import {
  MikroOrmLedgerUnitOfWork,
  MikroOrmWalletUnitOfWork,
} from "./infrastructure/persistence/wallet.unit-of-work.ts";
import { ProcessReconciliationObserver } from "./infrastructure/reconciliation.observer.ts";
import { ReconciliationMetricsController } from "./presentation/reconciliation-metrics.controller.ts";
import { TransactionController } from "./presentation/transaction.controller.ts";
import { WalletController } from "./presentation/wallet.controller.ts";

@Module({
  imports: [MikroOrmModule.forFeature([WalletSchema])],
  controllers: [
    WalletController,
    TransactionController,
    ReconciliationMetricsController,
  ],
  providers: [
    ProcessReconciliationObserver,
    {
      provide: ReconciliationUseCases,
      useFactory: (
        em: EntityManager,
        observer: ProcessReconciliationObserver,
      ) =>
        new ReconciliationUseCases(
          new MikroOrmReconciliationReader(em),
          observer,
        ),
      inject: [EntityManager, ProcessReconciliationObserver],
    },
    {
      provide: LedgerUseCases,
      useFactory: (em: EntityManager) =>
        new LedgerUseCases(new MikroOrmLedgerUnitOfWork(em)),
      inject: [EntityManager],
    },
    {
      provide: TransactionUseCases,
      useFactory: (em: EntityManager) =>
        new TransactionUseCases(new MikroOrmTransactionUnitOfWork(em)),
      inject: [EntityManager],
    },
    {
      provide: WalletUseCases,
      useFactory: (em: EntityManager) =>
        new WalletUseCases(new MikroOrmWalletUnitOfWork(em)),
      inject: [EntityManager],
    },
  ],
})
export class WageringModule {}
