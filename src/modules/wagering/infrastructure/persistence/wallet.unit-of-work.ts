import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  WalletRepositoryPort,
  WalletUnitOfWork,
} from "../../application/wallet-ports.ts";
import { WalletRepository } from "./wallet.repository.ts";

export class MikroOrmWalletUnitOfWork implements WalletUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  execute<T>(
    operation: (repository: WalletRepositoryPort) => Promise<T>,
  ): Promise<T> {
    return this.em
      .fork()
      .transactional((transactionalEm) =>
        operation(new WalletRepository(transactionalEm)),
      );
  }
}
