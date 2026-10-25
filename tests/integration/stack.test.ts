import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CheckConstraintViolationException,
  ForeignKeyConstraintViolationException,
} from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { createApplication } from "../../src/main.ts";
import { createOrmOptions } from "../../src/platform/persistence/orm.config.ts";
import { Migration202610250001StackProbe } from "../support/stack/migration.ts";
import {
  ProbeAuditSchema,
  ProbeRecordSchema,
} from "../support/stack/probe.schema.ts";

describe("Bun + NestJS + MikroORM + PostgreSQL", () => {
  const databaseName = `stack_validation_${randomUUID().replaceAll("-", "")}`;
  let previousUrl: string | undefined;
  let admin: MikroORM | undefined;
  let orm: MikroORM;
  let observer: MikroORM;
  let app: INestApplication | undefined;
  let databaseCreated = false;

  beforeAll(async () => {
    previousUrl = process.env.DATABASE_URL;
    if (!previousUrl) {
      throw new Error("DATABASE_URL is required for the stack validation");
    }
    const baseOptions = createOrmOptions();
    admin = await MikroORM.init(baseOptions);

    // Only internally generated database names may be interpolated here.
    await admin.em.getConnection().execute(`create database "${databaseName}"`);
    databaseCreated = true;
    const testUrl = new URL(previousUrl);
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();

    const options = {
      ...createOrmOptions(),
      entities: [ProbeRecordSchema, ProbeAuditSchema],
      migrations: {
        migrationsList: [Migration202610250001StackProbe],
        snapshot: false,
      },
    };
    orm = await MikroORM.init(options);
    observer = await MikroORM.init(options);
  });

  afterAll(async () => {
    try {
      await app?.close();
      await observer?.close(true);
      await orm?.close(true);
      if (admin && databaseCreated) {
        await admin.em
          .getConnection()
          .execute(`drop database "${databaseName}" with (force)`);
      }
    } finally {
      await admin?.close(true);
      if (previousUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousUrl;
      }
    }
  });

  test("inicia HTTP com integração Nest/MikroORM e decorators sob Bun", async () => {
    app = await createApplication();
    await app.listen(0, "127.0.0.1");
    const response = await fetch(`${await app.getUrl()}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("aplica, reverte e reaplica migration no banco descartável", async () => {
    const migrator = orm.migrator;
    expect(await migrator.getPending()).toHaveLength(1);
    await migrator.up();
    expect(await migrator.getExecuted()).toHaveLength(1);
    await migrator.down();
    expect(await migrator.getExecuted()).toHaveLength(0);
    const tables = await observer.em
      .getConnection()
      .execute<{ record: string | null; audit: string | null }[]>(
        "select to_regclass('stack_probe_record') as record, to_regclass('stack_probe_audit') as audit",
      );
    expect(tables).toEqual([{ record: null, audit: null }]);
    await migrator.up();
    expect(await migrator.getPending()).toHaveLength(0);
  });

  test("confirma duas tabelas juntas e preserva decimal acima da precisão de number", async () => {
    const recordId = randomUUID();
    const auditId = randomUUID();
    const exactValue = "9007199254740993.27";
    await orm.em.fork().transactional(async (em) => {
      em.persist(em.create(ProbeRecordSchema, { id: recordId, exactValue }));
      // Flush the scalar reference first; this sends SQL without committing.
      await em.flush();
      expect(
        await observer.em.fork().count(ProbeRecordSchema, { id: recordId }),
      ).toBe(0);
      em.persist(em.create(ProbeAuditSchema, { id: auditId, recordId }));
    });
    const em = observer.em.fork();
    const record = await em.findOneOrFail(ProbeRecordSchema, recordId);
    expect(typeof record.exactValue).toBe("string");
    expect(record.exactValue).toBe(exactValue);
    expect(await em.findOneOrFail(ProbeAuditSchema, auditId)).toMatchObject({
      recordId,
    });
  });

  test("rollback remove gravação já enviada ao banco quando a segunda tabela falha", async () => {
    const recordId = randomUUID();
    const auditId = randomUUID();
    await expect(
      orm.em.fork().transactional(async (em) => {
        em.persist(
          em.create(ProbeRecordSchema, { id: recordId, exactValue: "25.00" }),
        );
        await em.flush();
        expect(await em.count(ProbeRecordSchema, { id: recordId })).toBe(1);
        expect(
          await observer.em.fork().count(ProbeRecordSchema, { id: recordId }),
        ).toBe(0);
        // Force a real FK violation after the first INSERT, before commit.
        em.persist(
          em.create(ProbeAuditSchema, { id: auditId, recordId: randomUUID() }),
        );
        await em.flush();
      }),
    ).rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
    const em = observer.em.fork();
    expect(await em.count(ProbeRecordSchema, { id: recordId })).toBe(0);
    expect(await em.count(ProbeAuditSchema, { id: auditId })).toBe(0);
  });

  test("PostgreSQL rejeita valor negativo por CHECK real", async () => {
    const id = randomUUID();
    await expect(
      orm.em.fork().transactional(async (em) => {
        em.persist(em.create(ProbeRecordSchema, { id, exactValue: "-0.01" }));
      }),
    ).rejects.toBeInstanceOf(CheckConstraintViolationException);
    expect(await observer.em.fork().count(ProbeRecordSchema, { id })).toBe(0);
  });
});
