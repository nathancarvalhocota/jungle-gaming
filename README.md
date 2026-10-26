# jungle-gaming

Serviço HTTP de processamento financeiro de apostas, construído para o desafio técnico. **Esta é uma entrega parcial**: o núcleo de Wallet, operações financeiras, idempotência persistente, ledger e reconciliação está implementado. Ainda faltam o consumidor SQS, a publicação da outbox e os workers necessários para concluir o fluxo de mensageria; por isso, o desafio não está integralmente concluído.

## Escopo entregue

Wallet pode ser aberta com saldo zero ou positivo; abertura positiva é auditada. A API processa BET, WIN, LOSS, REFUND e ROLLBACK. O processamento usa valores monetários exatos, idempotência persistente e lock por Wallet no PostgreSQL. Transação, saldo, ledger e intenção de outbox são gravados atomicamente. Há consultas de Wallet e transação, ledger paginado e reconciliação em um snapshot SQL. A suíte também contém provas de concorrência com três processos reais.

FAILED é reservado, sem caminho operacional implementado. Veja abaixo as limitações que impedem tratar o desafio como concluído.

## Tecnologias validadas

Versões efetivamente usadas ou disponíveis no ambiente de validação documentado:

| Tecnologia | Versão |
| --- | --- |
| Bun | 1.4.4 |
| TypeScript | 7.0.2 |
| NestJS | 12.2.0 |
| MikroORM / integração NestJS | 7.2.5 / 7.1.0 |
| PostgreSQL | 18.6 |
| Docker Engine / Compose | 29.9.2 / 5.6.1 |
| MiniStack no Compose | 1.5.32 |

Os guias de stack e arquitetura detalham compatibilidade e decisões. A suíte não exercita SQS.

## Executar localmente

Pré-requisitos: Bun 1.4.4, Docker com Compose e permissão local para criar e remover bancos descartáveis de teste. Na raiz do repositório, no PowerShell:

```powershell
bun install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d --wait postgres
bun run db:migrate
bun run start
```

A configuração local está em `.env.example`; revise `DATABASE_URL` em `.env` antes de aplicar migrations. O padrão aponta para `jungle_gaming` em localhost. `bun run db:migrate` altera o banco configurado; não o execute contra um banco com dados que devam ser preservados. `bun run db:migrate:down` reverte a migration mais recente no banco configurado e exige a mesma conferência do destino.

A API escuta em `http://127.0.0.1:3000`. `bun run dev` inicia o modo de observação. O serviço PostgreSQL é o único necessário para os exemplos abaixo; MiniStack pode ser iniciado separadamente com `docker compose up -d ministack`, mas nenhuma integração SQS está implementada.

Verificações:

```powershell
bun run typecheck
bun run lint
bun run test
```

Use `bun run test` para a suíte completa. O runner administra bancos descartáveis com prefixos conferidos; não execute os arquivos de teste HTTP diretamente com a URL herdada. Os testes não removem volumes Docker nem corrigem o banco de desenvolvimento.

## Endpoints

| Método e rota | Uso |
| --- | --- |
| `GET /health/live` | Liveness, sem readiness de dependências |
| `POST /wallets`, `GET /wallets/:walletId` | Criar e consultar Wallet |
| `POST /wagering/transactions` | Submeter BET, WIN, LOSS, REFUND ou ROLLBACK com `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | Consultar transação pelo ID interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar pela identidade externa |
| `GET /wallets/:walletId/ledger?limit=50&cursor=...` | Consultar ledger com cursor |
| `POST /wallets/:walletId/reconciliation` | Comparar saldo armazenado e saldo reconstruído |
| `GET /metrics` | Contadores locais de reconciliação em formato Prometheus |

Dinheiro usa strings decimais com duas casas e BRL. POST de operação retorna 201 quando processada, 200 no replay idempotente, 202 para referência pendente e 422 para rejeição financeira. Uma chave de idempotência com payload diferente retorna 409. A autenticação real está fora do escopo por decisão aceita; a extensão `NoAuthGuard` não autentica o chamador.

## Demonstração rápida

Com a API em execução, este exemplo PowerShell cria uma Wallet de BRL 25,37, envia uma BET de BRL 10, repete a mesma requisição, provoca conflito de payload, devolve a BET por REFUND, consulta o ledger e reconcilia a Wallet:

```powershell
$base = "http://127.0.0.1:3000"
$walletBody = @{ playerId = "player-demo"; initialBalance = @{ amount = "25.37"; currency = "BRL" } } | ConvertTo-Json -Compress
$wallet = Invoke-RestMethod -Method Post -Uri "$base/wallets" -ContentType "application/json" -Body $walletBody

$betBody = @{
  providerId = "provider-demo"; externalTransactionId = "bet-demo"
  playerId = "player-demo"; walletId = $wallet.id
  roundId = "round-demo"; gameId = "game-demo"; kind = "BET"
  money = @{ amount = "10.00"; currency = "BRL" }
} | ConvertTo-Json -Compress
$headers = @{ "Idempotency-Key" = "demo-bet-key" }
$bet = Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $headers -ContentType "application/json" -Body $betBody
$replay = Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $headers -ContentType "application/json" -Body $betBody
$replay.idempotentReplay

$changedBet = @{
  providerId = "provider-demo"; externalTransactionId = "bet-demo"
  playerId = "player-demo"; walletId = $wallet.id
  roundId = "round-demo"; gameId = "game-demo"; kind = "BET"
  money = @{ amount = "11.00"; currency = "BRL" }
} | ConvertTo-Json -Compress
try {
  Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $headers -ContentType "application/json" -Body $changedBet
} catch {
  [int]$_.Exception.Response.StatusCode
}

$refundBody = @{
  providerId = "provider-demo"; externalTransactionId = "refund-demo"
  playerId = "player-demo"; walletId = $wallet.id
  roundId = "round-demo"; gameId = "game-demo"; kind = "REFUND"
  referenceExternalTransactionId = "bet-demo"
  money = @{ amount = "10.00"; currency = "BRL" }
} | ConvertTo-Json -Compress
$refundHeaders = @{ "Idempotency-Key" = "demo-refund-key" }
Invoke-RestMethod -Method Post -Uri "$base/wagering/transactions" -Headers $refundHeaders -ContentType "application/json" -Body $refundBody
Invoke-RestMethod -Method Get -Uri "$base/wallets/$($wallet.id)/ledger"
Invoke-RestMethod -Method Post -Uri "$base/wallets/$($wallet.id)/reconciliation"
```

O resultado de replay deve indicar `idempotentReplay = true`; o conflito é HTTP 409. Cada execução cria registros novos, então use um `playerId` distinto ao repetir o exemplo.

## Limitações conhecidas

- Não há consumidor SQS nem inbox.
- A outbox persiste eventos, mas não há publicador; persistir intenção não significa que o evento foi publicado.
- Não há worker para resolver ou expirar `PENDING_REFERENCE`.
- Retry, DLQ, shutdown de mensagens e recuperação após crash não foram demonstrados.
- `FAILED` permanece reservado, sem caminho operacional implementado.
- Não há readiness PostgreSQL/SQS nem observabilidade operacional completa. As métricas de reconciliação são locais ao processo.
- `NoAuthGuard` é uma extensão sem autenticação real, mantida fora do escopo por decisão aceita.
- Os testes usam PostgreSQL real e comprovam concorrência com três processos; não demonstram processamento SQS.
- Não há promessa de desempenho, capacidade de produção ou conclusão integral do desafio.

## Documentação

- [Enunciado original](docs/challenge.md)
- [Arquitetura e decisões](docs/architecture.md)
- [Stack e compatibilidade](docs/stack.md)
- [Estrutura do código](docs/structure.md)
- [Convenções](docs/conventions.md)
- [Estratégia, evidências e limites dos testes](docs/testing.md)
- [Spec do fluxo financeiro persistente](docs/specs/fluxo-financeiro-persistente.md)
- [Acordo de trabalho](AGENTS.md)
