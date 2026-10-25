import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { WalletUseCases } from "./application/wallet.use-cases.ts";
import { WalletSchema } from "./infrastructure/persistence/wallet.schema.ts";
import { MikroOrmWalletUnitOfWork } from "./infrastructure/persistence/wallet.unit-of-work.ts";
import { WalletController } from "./presentation/wallet.controller.ts";

@Module({
  imports: [MikroOrmModule.forFeature([WalletSchema])],
  controllers: [WalletController],
  providers: [
    {
      provide: WalletUseCases,
      useFactory: (em: EntityManager) =>
        new WalletUseCases(new MikroOrmWalletUnitOfWork(em)),
      inject: [EntityManager],
    },
  ],
})
export class WageringModule {}
