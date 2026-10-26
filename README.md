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

## Testes manuais pelo Postman

Com a API em execução em `http://127.0.0.1:3000`, importe as collections incluídas no repositório:

- [Fluxos funcionais básicos](postman/jungle-gaming.postman_collection.json): abertura e consulta de Wallet, operações financeiras, replay idempotente, conflitos, ledger e reconciliação.
- [Validações críticas concorrentes](postman/jungle-gaming-critical.postman_collection.json): dez BETs idênticas com a mesma chave e disputa concorrente de saldo por duas BETs.

A variável `baseUrl` já aponta para `http://127.0.0.1:3000`. Se a API estiver em outra porta ou endereço, altere essa variável na collection antes de executar.

Na collection básica, envie as requisições em sequência, respeitando a ordem e os dados produzidos pelos passos anteriores. Você pode usar **Send** uma requisição por vez; confira o status HTTP e o corpo de cada resposta.

Na collection crítica, use o **Collection Runner**, uma pasta por execução, com **1 iteração** e **0 ms de delay**. Execute os três itens da pasta em ordem. O primeiro cria uma Wallet isolada; no segundo, um script dispara as requisições em paralelo para `POST /wagering/transactions` e pula o POST visível para não criar uma operação extra; o terceiro verifica as respostas, o saldo e a reconciliação. O item de disparo pode aparecer como pulado no Runner — isso é esperado. As verificações do cenário aparecem no terceiro item.

As collections exercitam os comportamentos observáveis pela API. Elas não substituem a suíte automatizada com PostgreSQL, não testam diretamente todas as constraints e triggers do banco e não demonstram processamento SQS.

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
