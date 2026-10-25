import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { WalletHttpErrorFilter } from "./modules/wagering/presentation/wallet-http-error.filter.ts";
import { WageringModule } from "./modules/wagering/wagering.module.ts";
import { HealthController } from "./platform/health/health.controller.ts";
import {
  HttpAuthGuard,
  NoAuthGuard,
} from "./platform/identity/no-auth.guard.ts";
import { createOrmOptions } from "./platform/persistence/orm.config.ts";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({ useFactory: createOrmOptions }),
    WageringModule,
  ],
  controllers: [HealthController],
  providers: [
    NoAuthGuard,
    { provide: APP_GUARD, useClass: HttpAuthGuard },
    { provide: APP_FILTER, useClass: WalletHttpErrorFilter },
  ],
})
export class AppModule {}
