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
      application/
        wallet-ports.ts
        wallet.errors.ts
        wallet.use-cases.ts
      infrastructure/persistence/
        wallet.schema.ts
        wallet.repository.ts
        wallet.unit-of-work.ts
        migrations/migration-202610250002-wallet-zero.ts
      presentation/
        wallet.controller.ts
        wallet-http-error.filter.ts
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
  integration/
    auth.test.ts
    stack.test.ts
    wallet.test.ts
  support/
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
| `src/modules/wagering/application` | Criação/consulta de Wallet zero e portas de persistência/transação |
| `src/modules/wagering/infrastructure/persistence` | Schema sem classe espelhada, reidratação, unidade de trabalho e migration de Wallet |
| `src/modules/wagering/presentation` | HTTP e respostas de erro de Wallet |
| `tests/unit` | Testes de domínio sem infraestrutura |
| `src/platform/health` | Liveness HTTP |
| `src/platform/identity` | Extensão de autenticação HTTP sem verificação de identidade |
| `src/platform/persistence` | Configuração geral da conexão e do ORM |
| `tests/integration` | Verificações com infraestrutura real |
| `tests/support/stack` | Migration e schemas exclusivos do banco descartável de compatibilidade |

O Compose fica na raiz em `compose.yaml`. Wallet zero já possui API e persistência; movimentações, transações financeiras, ledger persistido e outbox continuam pendentes. `bun run db:migrate` e `bun run db:migrate:down` usam o banco configurado, sem execução automática no startup.

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

As migrations e a unidade de trabalho de Wallet já estão em `wagering/infrastructure/persistence`; inbox/outbox continuam pendentes. A árvore não estabelece sozinha a fronteira transacional.

O schema de Wallet e sua conversão já ficam em `wagering/infrastructure`, sem classe de domínio espelhada. Os demais schemas financeiros continuam pendentes, conforme [arquitetura](architecture.md).

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
