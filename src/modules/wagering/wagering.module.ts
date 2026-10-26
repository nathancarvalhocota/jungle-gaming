import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { TransactionUseCases } from "./application/transaction.use-cases.ts";
import { WalletUseCases } from "./application/wallet.use-cases.ts";
import { MikroOrmTransactionUnitOfWork } from "./infrastructure/persistence/transaction.repository.ts";
import { WalletSchema } from "./infrastructure/persistence/wallet.schema.ts";
import { MikroOrmWalletUnitOfWork } from "./infrastructure/persistence/wallet.unit-of-work.ts";
import { TransactionController } from "./presentation/transaction.controller.ts";
import { WalletController } from "./presentation/wallet.controller.ts";

@Module({
  imports: [MikroOrmModule.forFeature([WalletSchema])],
  controllers: [WalletController, TransactionController],
  providers: [
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
