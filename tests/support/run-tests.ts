import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../../src/platform/persistence/orm.config.ts";

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl)
  throw new Error("DATABASE_URL is required for integration tests");
const databaseName = `suite_validation_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(configuredUrl);
adminUrl.pathname = "/postgres";
const admin = await MikroORM.init({
  ...createOrmOptions(),
  clientUrl: adminUrl.toString(),
});
let created = false;
let target: MikroORM | undefined;
let exitCode = 1;
try {
  await admin.em.getConnection().execute(`create database "${databaseName}"`);
  created = true;
  const testUrl = new URL(configuredUrl);
  testUrl.pathname = `/${databaseName}`;
  target = await MikroORM.init({
    ...createOrmOptions(),
    clientUrl: testUrl.toString(),
  });
  await assertDisposableTarget();
  console.info(`Test suite: database=${databaseName}`);
  const child = Bun.spawn(
    [process.execPath, "test", "tests", "--timeout", "30000"],
    {
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  exitCode = await child.exited;
} finally {
  try {
    if (created && target) {
      await assertDisposableTarget();
      console.info(`Test suite cleanup: database=${databaseName}`);
      await target.close(true);
      await admin.em
        .getConnection()
        .execute(`drop database "${databaseName}" with (force)`);
    }
  } finally {
    await target?.close(true);
    await admin.close(true);
  }
}
process.exitCode = exitCode;

async function assertDisposableTarget(): Promise<void> {
  if (!target) throw new Error("Disposable suite database is not initialized");
  const [row] = await target.em
    .getConnection()
    .execute<{ database: string }[]>("select current_database() as database");
  if (
    !/^suite_validation_[a-f0-9]{32}$/.test(databaseName) ||
    row?.database !== databaseName
  ) {
    throw new Error("Refusing an unexpected disposable suite database target");
  }
}
