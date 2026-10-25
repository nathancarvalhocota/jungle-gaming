import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";

export function createOrmOptions() {
  const clientUrl = process.env.DATABASE_URL;

  if (!clientUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const url = new URL(clientUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }

  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: { migrationsList: [] },
  });
}
