# Estratégia de testes

## Estado

Plano de validação financeira e evidência inicial de compatibilidade. A suíte técnica em `tests/integration/stack.test.ts` já foi executada com Bun e PostgreSQL real em container. Os cenários financeiros e SQS descritos abaixo continuam pendentes; a validação técnica não os substitui.

## Compatibilidade da stack

**Ambiente:** Windows, Bun 1.4.4, Docker Engine 29.9.2 e Compose 5.6.1. NestJS 12.2.0, MikroORM 7.2.5, `@mikro-orm/nestjs` 7.1.0, TypeScript 7.0.2, Biome 2.6.3 e imagem `postgres:18.6-bookworm`. O servidor confirmou PostgreSQL 18.6. Node 24.13 estava instalado, mas a aplicação e os testes foram executados por Bun.

**Comandos e resultados:**

| Comando | Resultado observado |
| --- | --- |
| `bun install` | Dependências diretas exatas instaladas e `bun.lock` gerado |
| `bun install --frozen-lockfile` | Instalação reproduzida a partir do lockfile, sem alterações |
| `docker compose config --quiet` | Configuração válida |
| `docker compose up -d --wait postgres` | PostgreSQL saudável; MiniStack existente preservado |
| `bun run typecheck` | Verificação estrita do código próprio sem erros |
| `bun run lint` | Biome sem erros ou avisos após correções |
| `bun run test:stack` | 5 testes passaram, 0 falharam, 18 asserções |
| `bun run test` | Mesmo resultado no comando geral da suíte disponível |
| `bun run start` + `GET /health/live` | Processo Bun iniciou NestJS e respondeu HTTP 200 com `{"status":"ok"}`; encerrado manualmente após a consulta |

**O que os testes demonstram:**

- Integração NestJS/MikroORM inicializa com PostgreSQL; rota HTTP usa decorators sob Bun. Após simplificação, a rota responde diretamente, sem um serviço intermediário para o status fixo. O teste importa a factory de `src/main.ts`; a abertura da porta de execução fica protegida por `import.meta.main`.
- Migration explícita e versionada aplica, reverte e reaplica duas tabelas no banco descartável. Uma conexão independente confirma sua remoção após `down`.
- A transação confirma registro e auditoria em duas tabelas. `numeric(30,2)` retorna `9007199254740993.27` como string pelo mapeamento decimal do ORM, sem passar por `number`.
- Após um primeiro `INSERT` e `flush`, a transação enxerga o registro e outra conexão não o enxerga. Uma violação real de FK na segunda tabela provoca rollback; nenhuma das duas gravações fica persistida.
- Um `CHECK` real rejeita valor negativo na tabela de ensaio.

Cada execução gera e remove um banco `stack_validation_<uuid>`. Foi consultado o catálogo PostgreSQL após os testes e não restaram bancos com esse prefixo. A migration e os schemas ficam apenas em `tests/support/stack`; não pertencem ao modelo financeiro. Snapshots de migrations estão desativados no ensaio para evitar arquivos gerados na raiz.

**Falhas encontradas e resolvidas:** os nomes dos métodos de migrations foram ajustados às APIs efetivamente instaladas no MikroORM 7. O primeiro teste de commit encontrou uma FK antes do registro referenciado: como o ensaio usa IDs escalares, a ordem passou a ser explícita com `flush` dentro da mesma transação. As asserções de erro exigem as exceções específicas de FK e CHECK, evitando aceitar uma falha arbitrária como evidência de rollback.

O primeiro download da imagem falhou no helper de credenciais Windows, com erro de sessão de logon. O pull público funcionou com configuração Docker temporária em `.tmp/docker-public/config.json`, contendo apenas `{"auths":{"https://index.docker.io/v1/":{}}}`, sem leitura ou alteração das credenciais globais. Foi usado `docker --config .tmp/docker-public --host npipe:////./pipe/dockerDesktopLinuxEngine pull postgres:18.6-bookworm`. Essa configuração local é ignorada pelo Git; o Compose iniciou normalmente depois do download.

**Limites:** não há evidência ainda de wallet/transação/ledger/inbox/outbox reais, locks, idempotência, três processos, workers, SQS ou recuperação após crash. A unidade de trabalho aprovada está documentada, mas seu contrato de aplicação ainda não foi implementado. O decimal do ensaio não decide precisão máxima ou representação de `Money`. A reversão de triggers e a imutabilidade do ledger serão testadas com o schema financeiro. O usuário PostgreSQL do ensaio tem privilégios de desenvolvimento; as constraints ainda precisam ser verificadas com o futuro papel restrito da aplicação. Liveness não verifica readiness. Logs estruturados e métricas do desafio permanecem pendentes. Não foi testado outro sistema operacional.

## Extensão de autenticação HTTP

`tests/integration/auth.test.ts` importa o `AppModule` real e adiciona um controller somente na fixture. Demonstra acesso sem `Authorization`, ausência de `user`, `auth` e `providerIdentity` na requisição e que header/payload com `providerId` e credenciais arbitrárias não criam essas identidades. Ao simular recusa no provider `NoAuthGuard`, a rota fixture retorna 403, enquanto `GET /health/live` continua respondendo 200 sem chamar esse provider. O teste original de bootstrap e os testes reais de PostgreSQL permanecem intactos.

Validação: `bun run typecheck` e `bun run lint` sem erros; `bun run test` com 8 testes passando, 0 falhas e 27 asserções. O primeiro lint apontou decorators de parâmetros desabilitados; o parser do Biome foi ajustado para o uso do NestJS. Não há autenticação ou autorização real, validação de tokens, vínculo de `providerId` a credenciais ou integração com IdP demonstrada. A substituição é simulada no método do provider via spy; não valida um IdP futuro.

## Unidade

`tests/unit/money.test.ts` valida `Money` sem NestJS ou banco: formatos e tipos runtime, BRL/USD, aritmética exata (`0.10 + 0.20 = 0.30`), sinais e zero, conflitos em todas as operações binárias, limites inclusivos e estouros positivos/negativos, serialização sem `bigint` exposto e imutabilidade inclusive em falhas. Entradas negativas são recusadas; resultados internos assinados não podem ser reconstruídos pela factory de entrada.

**Validação:** `bun run typecheck` e `bun run lint` passaram; `bun test tests/unit/money.test.ts` teve 86 testes passando e 213 asserções. `bun run test` teve 94 testes passando, 0 falhas e 240 asserções, incluindo os 8 testes HTTP/stack existentes com PostgreSQL real. Na primeira execução, três casos com arrays vazios foram interpretados como linhas sem argumentos pelo `test.each` e expiraram; o empacotamento dos parâmetros foi corrigido, sem alterar testes existentes.

**Limites:** somente `Money` em memória foi implementado. Persistência, reidratação com sinal, restrição da aplicação a BRL e regras de zero por operação permanecem pendentes. Wallet, ledger, estados terminais, referências, reversões e eventos ainda precisam de testes de domínio. Canonicalização/conflito de payload e idempotência persistente serão verificados nas etapas correspondentes.

## Integração

Usar containers, migrations reais e o caminho de processamento da aplicação.

- Rodar migrations de ida, volta e reaplicação em banco descartável.
- Tentar violar constraints e imutabilidade com SQL direto e papel da aplicação.
- Injetar falha entre gravações e comprovar rollback de wallet, transação, ledger, inbox e outbox.
- Verificar replay com saldo original após outras movimentações.
- Cobrir identificador externo repetido com outra chave e mesma chave com payload divergente.
- Cobrir duplicata por messageId e mensagens distintas para a mesma operação.
- Confirmar ack após commit, retry, DLQ e shutdown.
- Verificar eventos para LOSS, rejeição, referência pendente e mudança efetiva de saldo.
- Testar reconciliação consistente e cursor sem perdas/duplicações.

## Concorrência e recuperação

| Cenário | Evidência esperada |
| --- | --- |
| Mesma aposta 50 vezes simultaneamente | Um débito e um resultado financeiro |
| Duas apostas de 80.00 sobre 100.00 | Uma processada, uma rejeitada, saldo 20.00, um débito |
| Wallets diferentes | Paralelismo sem lock global |
| Três ou mais instâncias | Invariantes mantidas entre processos independentes |
| Morte após commit antes de ack | Redelivery sem repetir efeito |
| Dois publishers | Publicação sem perda e duplicatas identificáveis |
| REFUND/ROLLBACK antes da referência | Resolução posterior ou expiração auditável |
| Reinício | Trabalho retomado e saldo consistente |

Promises em um processo não comprovam três instâncias. Usar processos/containers independentes, conexões distintas e sincronização explícita para provocar disputa.

Hooks de falha devem ser controlados e indisponíveis na configuração normal. Confirmar encerramento real do processo antes de observar recuperação.

Em todo cenário financeiro, conferir wallet.balance igual ao saldo reconstruído pelo ledger, contagem/direção dos lançamentos e ausência de efeitos extras. Rejeições incluem failureCode e evento.

## Evidências

Registrar comando, ambiente, resultado e limitações. Indisponibilidade de Docker deixa testes pendentes; mocks não substituem essa evidência.

Typecheck e lint são checks separados. Adicionar comandos concretos ao README apenas quando existirem e forem verificados.
