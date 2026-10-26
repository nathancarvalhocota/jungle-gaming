import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../../src/platform/persistence/orm.config.ts";

export async function assertBetDatabase(
  orm: MikroORM,
  url: string,
  expected: string,
): Promise<void> {
  if (
    !/^bet_validation_[a-f0-9]{32}$/.test(expected) ||
    new URL(url).pathname !== `/${expected}`
  )
    throw new Error("Refusing an unexpected BET test database URL");
  const [row] = await orm.em
    .getConnection()
    .execute<{ database: string }[]>("select current_database() as database");
  if (row?.database !== expected)
    throw new Error("Refusing an unexpected BET test database target");
}

export async function createBetDatabase() {
  const configured = process.env.DATABASE_URL;
  if (!configured)
    throw new Error("DATABASE_URL is required for BET integration tests");
  const name = `bet_validation_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(configured);
  adminUrl.pathname = "/postgres";
  const admin = await MikroORM.init({
    ...createOrmOptions(),
    clientUrl: adminUrl.toString(),
  });
  let orm: MikroORM | undefined;
  let observer: MikroORM | undefined;
  const targetUrl = new URL(configured);
  targetUrl.pathname = `/${name}`;
  const url = targetUrl.toString();
  let created = false;
  try {
    await admin.em.getConnection().execute(`create database "${name}"`);
    created = true;
    orm = await MikroORM.init({ ...createOrmOptions(), clientUrl: url });
    observer = await MikroORM.init({ ...createOrmOptions(), clientUrl: url });
    await assertBetDatabase(orm, url, name);
    await orm.migrator.up();
    console.info(`BET tests: database=${name}`);
    const database = {
      name,
      url,
      orm,
      observer,
      close: async () => {
        let verified = false;
        try {
          try {
            await assertBetDatabase(database.observer, url, name);
            verified = true;
          } finally {
            try {
              await database.observer.close(true);
            } finally {
              await database.orm.close(true);
            }
          }
          if (verified) {
            console.info(`BET test cleanup: database=${name}`);
            await admin.em
              .getConnection()
              .execute(`drop database "${name}" with (force)`);
          }
        } finally {
          await admin.close(true);
        }
      },
    };
    return database;
  } catch (error: unknown) {
    let verified = false;
    try {
      if (orm) {
        await assertBetDatabase(orm, url, name);
        verified = true;
      }
    } finally {
      await observer?.close(true);
      await orm?.close(true);
      try {
        if (created && verified)
          await admin.em
            .getConnection()
            .execute(`drop database "${name}" with (force)`);
      } finally {
        await admin.close(true);
      }
    }
    throw error;
  }
}
