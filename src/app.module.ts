import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { HealthController } from "./platform/health/health.controller.ts";
import { createOrmOptions } from "./platform/persistence/orm.config.ts";

@Module({
  imports: [MikroOrmModule.forRootAsync({ useFactory: createOrmOptions })],
  controllers: [HealthController],
})
export class AppModule {}
