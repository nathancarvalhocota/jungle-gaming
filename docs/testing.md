# Estratégia e evidências de testes

## Fronteira de validação

A fronteira principal financeira é o caso de uso real com PostgreSQL real em container. Poucos percursos HTTP verificam o contrato e a ligação com o caso de uso; SQL direto demonstra constraints e triggers. Testes unitários exercitam invariantes do domínio sem infraestrutura. A especificação está em [fluxo financeiro persistente](specs/fluxo-financeiro-persistente.md).

## Ambiente e comandos

Ambiente validado: Windows, Bun 1.4.4, PostgreSQL 18.6 em Docker, NestJS 12.2.0 e MikroORM 7.2.5. Versões e fontes ficam em [stack](stack.md).

| Comando | Resultado |
| --- | --- |
| `bun run typecheck` | Tipos estritos sem erros |
| `bun run lint` | Biome sem erros ou avisos |
| `bun run test` | 141 testes passaram, zero falhas, 773 asserções |
| `git diff --check` | Sem erros de whitespace |

`bun run test` usa `tests/support/run-tests.ts`: a conexão administrativa deriva a URL configurada e troca o banco por `/postgres`, sem conectar ao banco de desenvolvimento. Um banco `suite_validation_<uuid>` recebe a execução completa, inclusive testes de autenticação e bootstrap, por variável `DATABASE_URL` explícita no subprocesso. As suítes técnicas e financeiras criam bancos adicionais `stack_validation_<uuid>` e `wallet_validation_<uuid>`, com observadores independentes. Prefixo gerado e `current_database()` precisam coincidir antes de migrar e limpar. A CLI financeira recebe também nome esperado e URL explícita; nome divergente é recusado antes da migration. Sem alvo confirmado, não se autoriza limpeza. Logs de teste mostram apenas nomes dos bancos, sem URLs ou credenciais.

`bun run test:stack` executa somente o ensaio técnico, que também administra por `/postgres` e usa seu banco descartável. Para a suíte completa, usar o runner; executar testes HTTP diretamente pode usar a URL herdada. Os testes não fazem limpeza do volume nem correção do banco de desenvolvimento.

## Evidências implementadas

### Domínio

- `Money`: formato estrito, escala, BRL/USD, aritmética inteira exata, sinais, conflitos de moeda, limites inclusivos e serialização em strings sem expor bigint.
- `Wallet` e `WalletLedgerEntry`: abertura, versão, débito/crédito, insuficiência, rejeição de movimentação zero, aritmética do lançamento e preservação de estado após falha; reidratação sem repetir movimentos e datas defensivas.
- `WagerTransaction`: OPENING interna nasce PENDING, guarda resultado e instante em PROCESSED, bloqueia nova transição terminal e reidrata sem processamento. Identificadores externos não são fabricados.
- Eventos e outbox: dois envelopes concretos v1, dinheiro em string, dados aninhados imutáveis, cópias defensivas de datas/payload, enqueue pendente com zero tentativas e reidratação. Valores não JSON, incluindo bigint, Date aninhado e ciclos, são recusados.

### Abertura persistente

`tests/integration/wallet.test.ts` verifica aplicação e PostgreSQL reais:

- Abertura positiva de `0.01`, `25.37` e `1000000.00 BRL`: Wallet versão 1, uma OPENING processada, um CREDIT de zero ao saldo e exatamente dois eventos na outbox, com identidades, agregados e correlação esperados. Soma do ledger reconstrói o saldo.
- Abertura zero sem transação, lançamento ou evento; criação/consulta mantêm contratos e dados persistidos.
- Reidratação de Wallet, transação, ledger e outbox conserva valores exatos, IDs, datas e estados.
- Três criações positivas concorrentes para o mesmo jogador/moeda produzem uma Wallet, uma OPENING, um crédito e dois eventos; as demais retornam conflito. Isto demonstra unicidade de criação, não processamento entre três processos.
- Falha provocada após cada uma das cinco escritas reais: Wallet, transação, ledger e cada evento. A conexão independente não observa nenhum efeito antes do commit nem após o rollback, inclusive quando os dois registros da outbox já foram enviados ao PostgreSQL. O wrapper de falha fica somente no teste; não há hook na configuração de produção.
- SQL direto rejeita duplicidade transação/Wallet, vínculo a outra Wallet/moeda/valor, jogador incompatível, valores negativos, zero monetário do lançamento, teto excedido e aritmética inconsistente. UPDATE, DELETE e TRUNCATE do ledger são recusados por trigger.
- Migrations reais aplicam, revertem e reaplicam. A reversão da abertura remove tabelas e função do trigger; após reaplicar, as proteções SQL são exercitadas.
- HTTP verifica POST 201 e GET 200 para zero e positivo, conflito 409, validação runtime, moeda indisponível, JSON malformado, ID inválido e ausência 404. Testes unitários do filtro verificam 503 para causas reconhecidas e 500 genérico sem detalhes internos.

As fixtures SQL usadas para testar constraints podem criar transações sem lançamento. O schema não garante auditoria completa de INSERTs manuais nem igualdade global entre saldo e soma do ledger; o caso de uso coordena a abertura atomicamente. Administrador/proprietário pode remover os triggers; papel restrito separado permanece pendente.

### Compatibilidade e autenticação

O ensaio técnico preserva bootstrap NestJS/Bun, migrations reversíveis, commit conjunto, rollback após flush observado por outra conexão, FK/CHECK reais e decimal exato acima da precisão de number em tabelas exclusivas de teste. Esse decimal técnico não define a representação financeira, que usa bigint em centésimos.

A suíte de autenticação verifica ausência de identidade fabricada, acesso com NoAuthGuard e health público mesmo quando esse provider recusa a rota de ensaio. Não demonstra autenticação real nem vínculo entre providerId e credenciais.

## Limites e continuidade

Ainda não foram demonstrados: BET/WIN/LOSS/REFUND/ROLLBACK persistentes, idempotência externa, locks financeiros, três processos reais, consultas de ledger/reconciliação, inbox, SQS, ack, retry/DLQ, publishers concorrentes e recuperação após crash. A outbox guarda somente intenção pendente; nenhum evento foi publicado neste ticket. Readiness, métricas e logs operacionais completos permanecem pendentes.

Para os próximos tickets, manter os cenários do desafio: cinquenta duplicatas, duas BET de 80.00 sobre saldo 100.00, Wallets distintas sem lock global, três processos, referências fora de ordem, reversões e recuperação. Em cada cenário financeiro, conferir saldo reconstruído pelo ledger e ausência de efeitos extras. Mocks não substituem PostgreSQL ou SQS reais. Indisponibilidade de infraestrutura deve ser informada como cenário não verificado.
