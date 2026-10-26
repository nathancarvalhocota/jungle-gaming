# Estrutura do projeto

## Código atual

```text
src/
  main.ts
  app.module.ts
  modules/
    wagering/
      domain/
        money.ts
        wallet/
          wallet.ts
        ledger/
          wallet-ledger-entry.ts
        transactions/
          wager-transaction.ts
        events/
          integration-event.ts
          opening-events.ts
          transaction-rejected.ts
          transaction-pending-reference.ts
          outbox-message.ts
      application/
        wallet-ports.ts
        wallet.errors.ts
        wallet.use-cases.ts
        transaction-input.ts
        transaction-ports.ts
        transaction.use-cases.ts
      infrastructure/persistence/
        wallet.schema.ts
        wallet.repository.ts
        wallet.unit-of-work.ts
        transaction.repository.ts
        opening.schema.ts
        migrations/migration-202610250002-wallet-zero.ts
        migrations/migration-202610250003-auditable-opening.ts
        migrations/migration-202610250004-idempotent-bet.ts
        migrations/migration-202610260005-win-loss-references.ts
        migrations/migration-202610260006-refund.ts
        migrations/migration-202610260007-rollback.ts
      presentation/
        wallet.controller.ts
        wallet-http-error.filter.ts
        transaction.controller.ts
      wagering.module.ts
  platform/
    health/
      health.controller.ts
    identity/
      no-auth.guard.ts
    persistence/
      orm.config.ts
      migrate.ts
tests/
  unit/
    money.test.ts
    wallet.test.ts
    wallet-ledger-entry.test.ts
    wallet-http-error.filter.test.ts
    auditable-opening.test.ts
    bet.test.ts
    win-loss.test.ts
    refund.test.ts
    rollback.test.ts
  integration/
    auth.test.ts
    stack.test.ts
    wallet.test.ts
    bet.test.ts
    win-loss.test.ts
    refund.test.ts
    rollback.test.ts
  support/
    run-tests.ts
    bet-database.ts
    bet-process.ts
    transaction-process.ts
    stack/
      migration.ts
      probe.schema.ts
```

| Local | Responsabilidade |
| --- | --- |
| `src/main.ts` | Monta a aplicação e abre o servidor quando executado diretamente; exporta a factory usada pelos testes |
| `src/app.module.ts` | Compõe dependências e controllers NestJS |
| `src/modules/wagering/domain/money.ts` | Objeto de valor monetário puro, sem NestJS ou ORM |
| `src/modules/wagering/domain/wallet` | Saldo e movimentações da carteira em memória |
| `src/modules/wagering/domain/ledger` | Lançamento imutável e direção de débito/crédito |
| `src/modules/wagering/application` | Criação/consulta de Wallet, abertura auditável, processamento/consulta de BET/WIN/LOSS/REFUND/ROLLBACK e portas transacionais |
| `src/modules/wagering/domain/transactions` | OPENING interna e BET/WIN/LOSS/REFUND/ROLLBACK externas, resultados, referências e reidratação |
| `src/modules/wagering/domain/events` | Envelope abstrato, eventos concretos de abertura e intenção persistida da outbox |
| `src/modules/wagering/infrastructure/persistence` | Schema sem classe espelhada, reidratação, unidade de trabalho e migration de Wallet |
| `src/modules/wagering/presentation` | HTTP e respostas de erro de Wallet |
| `tests/unit` | Testes de domínio sem infraestrutura |
| `src/platform/health` | Liveness HTTP |
| `src/platform/identity` | Extensão de autenticação HTTP sem verificação de identidade |
| `src/platform/persistence` | Configuração geral da conexão e do ORM |
| `tests/integration` | Verificações com infraestrutura real |
| `tests/support/stack` | Migration e schemas exclusivos do banco descartável de compatibilidade |

O Compose fica na raiz em `compose.yaml`. Wallet e BET/WIN/LOSS/REFUND/ROLLBACK possuem HTTP e persistência atômica com ledger quando há movimento e outbox. Publicação continua pendente. `bun run db:migrate` e `bun run db:migrate:down` usam o banco configurado, sem execução automática no startup. `tests/support/run-tests.ts` isola a suíte completa em banco descartável desde a inicialização do executor.

WIN/LOSS ampliam o mesmo caso de uso, entidade e repositório de transações. O evento concreto de pendência está em `domain/events/transaction-pending-reference.ts`; a migration incremental mantém as anteriores. `tests/unit/win-loss.test.ts` e `tests/integration/win-loss.test.ts` cobrem as novas políticas; `bet.test.ts` reaproveita a barreira e os três subprocessos para WIN/LOSS/pendência e disputa do teto. Workers de referências continuam pendentes.

REFUND amplia a mesma entidade e o caso de uso; a consulta de compensações usa o repositório transacional. A migration incremental instala o índice único compartilhado com ROLLBACK, agora processado. Os testes próprios de REFUND cobrem o percurso completo sem repetir as matrizes anteriores. ROLLBACK amplia o mesmo fluxo e possui testes próprios; o helper IPC de REFUND foi extraído para compartilhar os três subprocessos seguros, sem duplicar a suíte.

## Organização por funcionalidade

A organização por funcionalidade foi aceita em [arquitetura](architecture.md). O desenho abaixo inclui `Money`, `wallet` e `ledger`, já implementados em memória; as demais partes financeiras continuam propostas. Criar cada pasta conforme a necessidade concreta:

```text
src/
  modules/
    wagering/
      domain/
        money.ts
        wallet/
        transactions/
        ledger/
        events/
      application/
      infrastructure/
      presentation/
      wagering.module.ts
  platform/
    persistence/
    messaging/
    observability/
    health/
    identity/
  shared/
    domain/
tests/
  unit/
  integration/
  concurrency/
  support/
```

Dentro da funcionalidade, `domain` concentra regras e estados; `application`, casos de uso e portas; `infrastructure`, adaptadores de persistência e integrações; `presentation`, entradas como controllers. Os adaptadores devem respeitar as dependências definidas em [convenções](conventions.md).

`platform` agrupa recursos técnicos gerais conforme surgirem. Adaptadores específicos do negócio permanecem na funcionalidade. `Money` está implementado em `wagering/domain/money.ts`. `shared` só recebe conceitos com compartilhamento concreto. Divisões de uma solution .NET não exigem pacotes ou serviços independentes em NestJS.

As migrations, unidade de trabalho, schemas de Wallet, OPENING, ledger e outbox estão em `wagering/infrastructure/persistence`; inbox e publicação continuam pendentes. A árvore não estabelece sozinha a fronteira transacional.

Os schemas e conversões ficam em `wagering/infrastructure`, sem classes de domínio espelhadas. Inbox continua pendente, conforme [arquitetura](architecture.md).

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [README](../README.md) | Apresentação e execução rápida |
| [AGENTS](../AGENTS.md) | Acordo de trabalho e referências para agentes |
| [Desafio](challenge.md) | Enunciado original, preservado |
| [Stack](stack.md) | Tecnologias e compatibilidade |
| [Arquitetura](architecture.md) | Decisões, alternativas e consequências |
| [Convenções](conventions.md) | Regras de escrita e manutenção do código |
| [Testes](testing.md) | Estratégia, evidências e limitações |
| [Spec financeira](specs/fluxo-financeiro-persistente.md) | Escopo de integração, critérios de teste e políticas pendentes; implementação não autorizada pela publicação |

Documentos usam nomes minúsculos; `README.md` e `AGENTS.md` mantêm seus nomes convencionais na raiz. `AGENTS.md` e `docs/agents/` são versionados. O roadmap e a pesquisa são apoio local excluído em `.git/info/exclude`; `.scratch/` é local e está no `.gitignore`.
