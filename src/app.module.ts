import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { HealthController } from "./platform/health/health.controller.ts";
import {
  HttpAuthGuard,
  NoAuthGuard,
} from "./platform/identity/no-auth.guard.ts";
import { createOrmOptions } from "./platform/persistence/orm.config.ts";

@Module({
  imports: [MikroOrmModule.forRootAsync({ useFactory: createOrmOptions })],
  controllers: [HealthController],
  providers: [NoAuthGuard, { provide: APP_GUARD, useClass: HttpAuthGuard }],
})
export class AppModule {}
