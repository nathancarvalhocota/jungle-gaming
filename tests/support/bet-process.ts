import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { TransactionUseCases } from "../../src/modules/wagering/application/transaction.use-cases.ts";
import { MikroOrmTransactionUnitOfWork } from "../../src/modules/wagering/infrastructure/persistence/transaction.repository.ts";
import { createOrmOptions } from "../../src/platform/persistence/orm.config.ts";
import { assertBetDatabase } from "./bet-database.ts";

const url = process.env.BET_DATABASE_URL;
const expected = process.env.BET_EXPECTED_DATABASE;
if (
  !url ||
  !expected ||
  !/^bet_validation_[a-f0-9]{32}$/.test(expected) ||
  new URL(url).pathname !== `/${expected}`
)
  throw new Error("Explicit disposable BET target is required");
const orm = await MikroORM.init({ ...createOrmOptions(), clientUrl: url });
try {
  await assertBetDatabase(orm, url, expected);
  const start = new Promise<void>((resolve) =>
    process.once("message", (message) => {
      if (message === "start") resolve();
    }),
  );
  process.send?.({ type: "ready", pid: process.pid });
  await start;
  const jobs: { body: unknown; key: string }[] = JSON.parse(
    process.env.BET_JOBS ?? "[]",
  );
  const useCases = new TransactionUseCases(
    new MikroOrmTransactionUnitOfWork(orm.em),
  );
  const results = await Promise.all(
    jobs.map(async (job) => {
      try {
        return { result: await useCases.submit(job.body, job.key) };
      } catch (error: unknown) {
        return {
          error:
            error instanceof Error && "code" in error
              ? error.code
              : "UNEXPECTED",
        };
      }
    }),
  );
  process.send?.({ type: "result", pid: process.pid, results });
} finally {
  await orm.close(true);
  process.disconnect?.();
}
