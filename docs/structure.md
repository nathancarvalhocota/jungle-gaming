# Estrutura do projeto

## Código atual

```text
src/
  main.ts
  app.module.ts
  platform/
    health/
      health.controller.ts
    persistence/
      orm.config.ts
tests/
  integration/
    stack.test.ts
  support/
    stack/
      migration.ts
      probe.schema.ts
```

| Local | Responsabilidade |
| --- | --- |
| `src/main.ts` | Monta a aplicação e abre o servidor quando executado diretamente; exporta a factory usada pelos testes |
| `src/app.module.ts` | Compõe dependências e controllers NestJS |
| `src/platform/health` | Liveness HTTP |
| `src/platform/persistence` | Configuração geral da conexão e do ORM |
| `tests/integration` | Verificações com infraestrutura real |
| `tests/support/stack` | Migration e schemas exclusivos do banco descartável de compatibilidade |

O Compose fica na raiz em `compose.yaml`. Ainda não há domínio financeiro, repositórios da aplicação ou migrations financeiras.

## Organização por funcionalidade

A organização por funcionalidade foi aceita em [arquitetura](architecture.md). O desenho abaixo permanece como ponto de partida; criar cada pasta conforme a necessidade concreta:

```text
src/
  modules/
    wagering/
      domain/
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

`platform` agrupa recursos técnicos gerais conforme surgirem. Adaptadores específicos do negócio permanecem na funcionalidade. `shared` só recebe conceitos com compartilhamento concreto; a posição de `Money` continua pendente. Divisões de uma solution .NET não exigem pacotes ou serviços independentes em NestJS.

Definir a localização das migrations financeiras, inbox/outbox e unidade de trabalho ao implementar persistência. A árvore não estabelece sozinha a fronteira transacional.

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

Documentos usam nomes minúsculos; `README.md` e `AGENTS.md` mantêm seus nomes convencionais na raiz. `AGENTS.md` e `docs/agents/` são versionados. O roadmap e a pesquisa são apoio local excluído em `.git/info/exclude`; `.scratch/` é local e está no `.gitignore`.
