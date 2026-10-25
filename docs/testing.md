# Estratégia de testes

## Estado

Plano de validação financeira e evidências de compatibilidade e Wallet zero. As suítes técnicas e de Wallet executam com Bun e PostgreSQL real em container. Os demais cenários financeiros e SQS descritos abaixo continuam pendentes; a validação inicial não os substitui.

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

**Limites:** não há evidência ainda de persistência financeira de wallet/transação/ledger/inbox/outbox, locks, idempotência, três processos, workers, SQS ou recuperação após crash. A unidade de trabalho aprovada está documentada, mas seu contrato de aplicação ainda não foi implementado. O decimal do ensaio não decide precisão máxima ou representação de `Money`. A reversão de triggers e a imutabilidade do ledger serão testadas com o schema financeiro. O usuário PostgreSQL do ensaio tem privilégios de desenvolvimento; as constraints ainda precisam ser verificadas com o futuro papel restrito da aplicação. Liveness não verifica readiness. Logs estruturados e métricas do desafio permanecem pendentes. Não foi testado outro sistema operacional.

## Extensão de autenticação HTTP

`tests/integration/auth.test.ts` importa o `AppModule` real e adiciona um controller somente na fixture. Demonstra acesso sem `Authorization`, ausência de `user`, `auth` e `providerIdentity` na requisição e que header/payload com `providerId` e credenciais arbitrárias não criam essas identidades. Ao simular recusa no provider `NoAuthGuard`, a rota fixture retorna 403, enquanto `GET /health/live` continua respondendo 200 sem chamar esse provider. O teste original de bootstrap e os testes reais de PostgreSQL permanecem intactos.

Validação: `bun run typecheck` e `bun run lint` sem erros; `bun run test` com 8 testes passando, 0 falhas e 27 asserções. O primeiro lint apontou decorators de parâmetros desabilitados; o parser do Biome foi ajustado para o uso do NestJS. Não há autenticação ou autorização real, validação de tokens, vínculo de `providerId` a credenciais ou integração com IdP demonstrada. A substituição é simulada no método do provider via spy; não valida um IdP futuro.

## Unidade

`tests/unit/money.test.ts` valida `Money` sem NestJS ou banco: formatos e tipos runtime, BRL/USD, aritmética exata (`0.10 + 0.20 = 0.30`), sinais e zero, conflitos em todas as operações binárias, limites inclusivos e estouros positivos/negativos, serialização sem `bigint` exposto e imutabilidade inclusive em falhas. Entradas negativas são recusadas; resultados internos assinados não podem ser reconstruídos pela factory de entrada.

**Validação:** `bun run typecheck` e `bun run lint` passaram; `bun test tests/unit/money.test.ts` teve 86 testes passando e 213 asserções. `bun run test` teve 94 testes passando, 0 falhas e 240 asserções, incluindo os 8 testes HTTP/stack existentes com PostgreSQL real. Na primeira execução, três casos com arrays vazios foram interpretados como linhas sem argumentos pelo `test.each` e expiraram; o empacotamento dos parâmetros foi corrigido, sem alterar testes existentes.

**Limites de Money:** persistência, reidratação monetária com sinal, restrição da aplicação a BRL e regras de zero nas demais operações de negócio permanecem pendentes. Estados terminais, referências, reversões e eventos ainda precisam de testes de domínio. Canonicalização/conflito de payload e idempotência persistente serão verificados nas etapas correspondentes.

`tests/unit/wallet.test.ts` e `tests/unit/wallet-ledger-entry.test.ts` cobrem abertura BRL/USD, saldo/versão, débito total, crédito até o teto, lançamento coerente retornado, saldo insuficiente, zero, negativos e moedas divergentes, falha na construção do ledger sem mutação parcial, integridade estrutural na reidratação e imutabilidade de campos/datas. Reidratar preserva versão e estado sem gerar novos lançamentos; novos lançamentos inconsistentes ou de valor zero são recusados.

**Validação desta entrega:** `bun run typecheck` e `bun run lint` passaram; `bun test tests/unit/wallet.test.ts tests/unit/wallet-ledger-entry.test.ts` teve 26 testes passando e 223 asserções. `bun run test`: 120 testes passaram, 0 falhas e 463 asserções, incluindo PostgreSQL real e todos os testes anteriores intactos. Um comentário de teste runtime deslocado pelo formatador causou erro inicial de typecheck; sua posição foi corrigida antes da validação final.

**Limites de Wallet/ledger:** garantias demonstradas somente em memória. Não há unicidade persistente de carteira ou lançamento, locks, idempotência, schema imutável ou atomicidade SQL implementados. Abertura positiva ainda exige `OPENING` e `CREDIT` na mesma transação na entrega futura; `open` isolado não demonstra essa auditoria. A reidratação confia nas regras de criação já aplicadas ao estado persistido e conserva verificações estruturais, sem repetir transições.

## Integração

Para o fluxo financeiro, a fronteira principal aceita é o caso de uso com PostgreSQL real; poucos testes HTTP completos verificam o contrato e sua ligação com o processamento. Complementar com SQL direto para constraints/triggers e testes unitários de domínio, sem repetir toda a matriz em cada camada. O escopo está na [spec financeira](specs/fluxo-financeiro-persistente.md); a primeira entrega abaixo cobre somente Wallet zero.

Usar containers, migrations reais e o caminho de processamento da aplicação.

- Rodar migrations de ida, volta e reaplicação em banco descartável.
- Verificar ida e volta de Money/Wallet/ledger com `bigint` em centésimos e moeda separada, incluindo teto e reconstrução pelas factories; nenhum valor monetário pode passar por `number`.
- Tentar violar unicidade, não negatividade e teto por SQL direto; tentar `UPDATE`, `DELETE` e `TRUNCATE` no ledger para demonstrar seus triggers. Reverter e reaplicar também essas proteções; papel restrito da aplicação permanece melhoria futura.
- Injetar falha entre gravações e comprovar rollback de wallet, transação, ledger, inbox e outbox.
- Verificar replay com saldo original após outras movimentações.
- Cobrir identificador externo repetido com outra chave e mesma chave com payload divergente.
- Cobrir duplicata por messageId e mensagens distintas para a mesma operação.
- Confirmar ack após commit, retry, DLQ e shutdown.
- Verificar eventos para LOSS, rejeição, referência pendente e mudança efetiva de saldo.
- Testar reconciliação consistente e cursor sem perdas/duplicações.

### Wallet zero persistida — ticket 01

`tests/integration/wallet.test.ts` cobre caso de uso e PostgreSQL reais: migration de ida/volta/ida, criação/consulta, versão 1, positivo recusado sem escrita, validação runtime, disputa duplicada com um vencedor e CHECKs por SQL direto. Fixtures com `0.01`, `25.37` e `1000000.00` demonstram `bigint` exato, IDs, versão e datas preservados por `rehydrate`; não autorizam abertura positiva pela API. HTTP verifica códigos aprovados, JSON malformado e UUID inválido. Três testes do filtro usam causas controladas para 503/500; não demonstram indisponibilidade real do servidor.

**Validação:** `bun run typecheck` e `bun run lint` passaram. Os testes específicos tiveram 12 passando, 0 falhas e 77 asserções; `bun run test` teve 132 passando, 0 falhas e 540 asserções, incluindo PostgreSQL real e os testes anteriores preservados. Os comandos de migration foram exercitados em banco descartável.

**Isolamento:** subprocessos de migration recebem URL descartável explícita e nome esperado. O runner confere `current_database()` antes de migrar; o teste demonstra recusa de nome divergente antes da escrita. A limpeza exige prefixo permitido e confirmação do banco conectado; sem conexão inicializada, não é autorizada.

**Limites:** não há abertura positiva auditável, movimentação persistida, ledger/outbox, lock financeiro, idempotência ou prova de três instâncias. A concorrência demonstrada aqui é a unicidade de criação por jogador/moeda. A migration cria somente Wallet.

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
