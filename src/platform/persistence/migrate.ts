import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "./orm.config.ts";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  throw new Error("Specify migration direction: up or down");
}

const orm = await MikroORM.init(createOrmOptions());
try {
  const [target] = await orm.em
    .getConnection()
    .execute<{ database: string }[]>("select current_database() as database");
  const expectedDatabase = process.argv[3];
  if (!target || (expectedDatabase && target.database !== expectedDatabase)) {
    throw new Error("Migration database does not match the expected target");
  }
  console.info(`Migration ${direction}: database=${target.database}`);
  if (direction === "up") await orm.migrator.up();
  else await orm.migrator.down();
} finally {
  await orm.close(true);
}
