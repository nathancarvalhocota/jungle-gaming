import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";

export async function createApplication() {
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  app.enableShutdownHooks();
  return app;
}

// Importing the factory in tests must not start a server automatically.
if (import.meta.main) {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const app = await createApplication();
  try {
    await app.listen(port, "127.0.0.1");
  } catch (error: unknown) {
    await app.close();
    throw error;
  }
}
