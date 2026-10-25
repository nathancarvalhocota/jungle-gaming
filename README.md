# Distributed Wagering Processor

Serviço financeiro de apostas com precisão monetária, idempotência persistente, ledger auditável e recuperação após falhas.

## Estado atual

Bootstrap técnico executável: NestJS sob Bun, conexão MikroORM/PostgreSQL e `GET /health/live`. A suíte de compatibilidade usa PostgreSQL real em container e um banco descartável por execução para verificar migrations, commit, rollback, uma constraint e transporte decimal exato.

A entrada HTTP usa `NoAuthGuard` sem verificar credenciais nem criar identidade; health permanece público mesmo na substituição desse provider. Money, Wallet e lançamento existem no domínio. `POST /wallets` cria uma carteira com saldo `0.00 BRL`, e `GET /wallets/:walletId` recupera seu estado do PostgreSQL. Abertura positiva, operações de apostas, ledger/outbox persistidos, autenticação real, readiness e workers permanecem pendentes; as garantias demonstradas neste estágio não cobrem o fluxo financeiro completo.

O enunciado original está em [challenge.md](docs/challenge.md).

## Stack exigida

- Bun 1.x como runtime, gerenciador de pacotes e executor de testes.
- TypeScript estrito e NestJS.
- PostgreSQL, migrations versionadas e reversíveis.
- SQS em LocalStack ou MiniStack, com Docker Compose.
- MikroORM, preferencial no desafio, ou TypeORM.

Tecnologias, versões de referência e compatibilidade estão em [Stack](docs/stack.md). As decisões e seus motivos ficam em [Arquitetura](docs/architecture.md).

MiniStack 1.5.32 já está no Compose. A suíte atual não exercita SQS, FIFO ou DLQ.

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [Enunciado](docs/challenge.md) | Desafio original, preservado sem alterações |
| [Stack](docs/stack.md) | Tecnologias, responsabilidades e compatibilidade |
| [Arquitetura](docs/architecture.md) | Decisões aceitas, propostas e limitações |
| [Estrutura](docs/structure.md) | Arquivos atuais, localização de código e organização proposta |
| [Convenções](docs/conventions.md) | Idioma, nomenclatura e regras de código |
| [Testes](docs/testing.md) | Estratégia e evidências necessárias |
| [AGENTS](AGENTS.md) | Acordo de trabalho e orientações para agentes |

## Execução e validação

Pré-requisitos: Bun 1.4.4 e Docker com Compose funcionando. No PowerShell, na raiz do repositório:

```powershell
bun install --frozen-lockfile
# Copy only if your local configuration does not exist yet.
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d --wait postgres
bun run typecheck
bun run lint
bun run test:stack
bun run db:migrate
bun run start
```

A API escuta em `http://127.0.0.1:3000`. Em outro terminal, `Invoke-RestMethod http://127.0.0.1:3000/health/live` retorna `{"status":"ok"}`. Use Ctrl+C para encerrar. `bun run dev` executa com observação de alterações; `bun run format` aplica formatação e correções seguras de lint.

`bun run db:migrate` aplica as migrations no banco configurado em `DATABASE_URL`; confira esse destino antes de executar. `bun run test` executa a suíte completa; `bun run test:stack` seleciona apenas o ensaio de compatibilidade. Os testes aplicam, revertem e reaplicam migrations em bancos descartáveis. O teste financeiro exercita também a CLI de migrations, com URL explícita e verificação do nome esperado antes de alterar o schema.

Para testar no Postman, envie `POST http://127.0.0.1:3000/wallets` com corpo JSON `{"playerId":"player-demo","initialBalance":{"amount":"0.00","currency":"BRL"}}`. A resposta 201 inclui o `id`; consulte-o em `GET /wallets/:walletId`. Saldo positivo retorna temporariamente 422 sem escrita, e jogador/moeda duplicado retorna 409.

O PostgreSQL é publicado apenas em `127.0.0.1:5432`, com credenciais locais descartáveis em `.env.example` e `compose.yaml`. O usuário local tem permissão para criar/remover bancos: as suítes usam bancos gerados `stack_validation_<uuid>` e `wallet_validation_<uuid>`, com conexões independentes. O teste financeiro verifica o destino descartável antes das migrations e da limpeza. Essa configuração não define as permissões do futuro papel da aplicação financeira.

O serviço PostgreSQL permanece disponível após os testes. Para pará-lo, use `docker compose stop postgres`, preservando seu volume e o MiniStack. Para iniciar o emulador, use `docker compose up -d ministack`.

Evidências dos testes e limites estão em [docs/testing.md](docs/testing.md).

## Processo de construção

O candidato participa das decisões e da revisão dos cenários; a IA auxilia na implementação e documentação. Cada etapa registra comportamento entregue, testes executados e limitações conhecidas.

Prioridade: correção financeira, concorrência, idempotência e recuperação. Funcionalidades opcionais entram depois dos requisitos obrigatórios.
