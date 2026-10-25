# Arquitetura

Requisitos obrigatórios estão no [desafio](challenge.md). Esta página registra escolhas e pendências; versões ficam em [stack](stack.md), arquivos em [estrutura](structure.md) e evidências em [testes](testing.md). A base técnica foi validada; as garantias financeiras persistentes ainda não foram implementadas.

## Decisões aceitas

| Tema | Escolha e motivo | Custo ou alternativa considerada |
| --- | --- | --- |
| Organização | Por funcionalidade, mantendo domínio, aplicação e adaptadores distintos; aproxima código relacionado | Alternativa: camadas globais. Pastas não impõem isolamento de dependências; a árvore exata continua proposta |
| Suporte técnico | Criar `platform` e abstrações conforme a necessidade; adaptadores de negócio permanecem na funcionalidade | Evita estrutura antecipada; exige distinguir recurso geral de detalhe do negócio. `shared` depende de compartilhamento concreto |
| Localização de Money | `src/modules/wagering/domain/money.ts`: objeto de valor próximo das regras financeiras que o utilizam | Alternativa: `shared/domain`. Extrair apenas quando outro módulo precisar da mesma definição e regras; implementado em memória |
| Moedas | `Money` reconhece uma lista explícita, inicialmente BRL e USD; aplicação oferece somente BRL. Operações entre moedas diferentes geram erro | Preserva o modelo multimoeda exigido. Alternativa: validar apenas três letras, permitindo códigos desconhecidos. Lista exige manutenção; ampliar o produto exige revisar escala, limites e contratos, sem conversão cambial implícita |
| Entrada monetária | String com exatamente duas casas, conforme o desafio; adicionalmente, rejeitar espaços, sinal `+` e zeros à esquerda, exceto o zero antes do separador em `0.00` | Alternativa: aceitar variações e normalizar. Formato estrito mantém um contrato único; exige formatação correta pelo cliente, sem correção silenciosa |
| ORM | MikroORM, preferido pelo desafio, com Unit of Work e Identity Map explícitos | TypeORM foi considerado. Exige contexto isolado e mapeamento separado do domínio; a compatibilidade inicial passou, não o processamento financeiro |
| Money interno | `bigint` em centésimos: escala fixa de duas casas e aritmética inteira exata, sem biblioteca decimal | Alternativa: biblioteca decimal. Exige conversão validada entre string decimal e inteiro, sem passar por `number`; entrada e saída permanecem strings com duas casas. Persistência ainda pendente |
| Limite de Money | Magnitude até `1000000.00`, inclusive; limite escolhido para tornar o escopo explícito e fácil de explicar, sem alegar padrão de mercado | Alternativa: teto técnico maior. Centralizar em `Money.MAX_MINOR_UNITS = 100_000_000n`; restringe valores individuais, saldos e resultados de operações |
| Versões | Estáveis recentes, respeitando Bun 1.x; fixar dependências, lockfile e imagens após validação | Cada atualização exige conferir compatibilidade; combinação atual em [stack](stack.md) |
| SQS local | MiniStack via Compose, evitando cadastro/token na opção avaliada de LocalStack | Emulação não comprova equivalência total com AWS; FIFO e DLQ ainda sem testes |
| Transações | Porta de unidade de trabalho fornece repositórios vinculados à mesma transação | Acrescenta coordenação; alternativa: EntityManager diretamente no caso de uso, com acoplamento ao ORM |
| Wallet e ledger | Implementados em memória: `debit` e `credit` constroem e retornam o lançamento antes de atualizar saldo, versão e data; falhas preservam a wallet. Ambos e `WalletLedgerEntry.create` rejeitam zero, mantendo cada movimentação bem-sucedida associada a um lançamento efetivo; `Money.zero` e abertura com zero continuam permitidos | Alternativas: criar o lançamento no caso de uso ou acumular pendências na wallet. Wallet não carrega histórico; a persistência atômica de ambos cabe à futura unidade de trabalho. LOSS não chama os métodos de movimentação |
| Escopo da idempotência | `idempotencyKey` globalmente única no PostgreSQL; HTTP usa o header e SQS fornece a chave ao mesmo caso de uso. Mesma chave e payload igual recuperam o resultado persistido; payload divergente gera conflito | Alternativa: unicidade por provedor. Escopo global exige coordenação entre integrações; o formato sugerido `providerId:externalTransactionId` evita colisões entre provedores distintos. Constraint e tratamento da disputa ainda não implementados |
| Identidade externa | `(providerId, externalTransactionId)` único no PostgreSQL; a mesma operação com outra chave de idempotência gera conflito, sem nova movimentação | Alternativa: reconhecer várias chaves como aliases da mesma operação, exigindo coordenação adicional. Nova operação exige novo identificador externo; implementação e testes pendentes |
| Concorrência por wallet | Lock pessimista na linha da wallet com `SELECT ... FOR UPDATE`, adquirido antes de ler o saldo para decidir e mantido até commit/rollback; serializa operações da mesma carteira entre instâncias | Alternativas: versão otimista com retry limitado ou UPDATE condicionado. Simplifica a coordenação financeira; custa espera em carteiras disputadas. Manter transação curta, sem chamadas externas; timeouts e deadlocks exigem tratamento. Implementação e testes ainda pendentes |
| Autenticação | Fora do escopo; prioriza correção financeira e preserva extensão futura | Sem verificação de identidade ou autorização HTTP nesta entrega; alternativa: integrar IdP agora |
| Inicialização | Conectar PostgreSQL antes de abrir HTTP; liveness responde sem consultar dependências | Aplicação não inicia sem banco. Iniciar em estado não pronto exigiria desenho adicional de recuperação |

O bootstrap concentra a inicialização em `src/main.ts`, importável pelos testes sem iniciar o servidor. Liveness retorna diretamente no controller. A árvore e suas propostas estão em [estrutura](structure.md).

O limite de `Money` está centralizado em `MAX_MINOR_UNITS`, validado pelo construtor privado na criação e em todos os resultados aritméticos. Entradas externas não aceitam negativos; valores internos podem variar de `-1000000.00` a `1000000.00` para suportar negação e diferenças. O limite é nominal na moeda do objeto, sem conversão cambial. Excedê-lo gera erro de domínio, sem truncamento ou arredondamento; não há limites diferentes por aposta, depósito ou saque definidos nesta decisão. A classe é imutável em runtime e lança `MoneyError` para entradas, moedas ou resultados inválidos. `toString()` usa o formato `25.00 BRL`; `toJSON()` retorna strings com duas casas, inclusive sinal para resultados negativos. Não há factory pública de reidratação.

Wallet recebe IDs e instante explicitamente: `open({ id, playerId, initialBalance, at })` e `debit/credit({ entryId, transactionId, money, at })`. A versão começa em 1 e aumenta apenas nas movimentações; datas são copiadas defensivamente. `rehydrate` restaura o estado com integridade estrutural, sem repetir transições; a factory de novos lançamentos valida também a aritmética. Abertura positiva isolada ainda não cumpre auditoria persistente: criar `OPENING` e seu `CREDIT` na mesma transação SQL permanece para o caso de uso e a unidade de trabalho, sem fabricar `transactionId` no domínio.

## Contrato transacional aceito

O caso de uso delimita uma transação por `em.transactional(...)`, encapsulado no adaptador da unidade de trabalho. Estado da operação, saldo, ledger, inbox quando aplicável e outbox usam o mesmo EntityManager, inclusive para SQL explícito. Repositórios não abrem transações independentes nem fazem commits próprios; domínio e caso de uso não dependem do ORM.

Cada requisição, mensagem ou trabalho usa contexto isolado. Falhas que abortam a operação propagam para rollback; rejeições de negócio são persistidas como resultados auditáveis, sem movimentação indevida. O replay deve recuperar o resultado original, incluindo o saldo observado naquele processamento.

O resultado necessário ao replay será persistido no próprio registro da transação financeira, incluindo status, saldo observado, moeda e código de rejeição quando aplicável, junto da chave e do hash do payload. Reenvio idêntico recupera esse resultado, sem reaplicar saldo, ledger ou eventos de processamento. Alternativa: tabela exclusiva de idempotência, com coordenação adicional.

Na disputa pela chave, usar QueryBuilder do MikroORM no adaptador, com `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, vinculado ao mesmo EntityManager transacional. Se não inserir, consultar o registro confirmado em comando seguinte sob `READ COMMITTED` e distinguir replay de conflito pelo hash, sem sobrescrever o original. Alternativa: SQL parametrizado no adaptador; evitar upsert que atualize automaticamente o resultado existente. O alvo acima cobre a chave; o tratamento da unicidade do identificador externo ainda precisa ser definido. Implementação e teste concorrente pendentes. Referências: [QueryBuilder](https://mikro-orm.io/docs/query-builder) e [isolamento PostgreSQL 18](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED).

Publicação SQS e confirmação da mensagem recebida ocorrem após commit. A outbox guarda a intenção atomicamente; publicação pode repetir após falha, exigindo deduplicação pela identidade estável do evento. Atomicidade não substitui concorrência, idempotência ou constraints.

A API e o consumidor SQS reutilizarão o mesmo caso de uso. A composição de wallet, transações e ledger em um módulo financeiro continua proposta; não implica serviços ou transações independentes. Contratos dos repositórios e implementação da unidade de trabalho continuam pendentes. Os testes atuais comprovam apenas o mecanismo SQL em tabelas de ensaio.

Referências: [transações MikroORM](https://mikro-orm.io/docs/transactions), [contexto isolado](https://mikro-orm.io/docs/identity-map), [Unit of Work](https://mikro-orm.io/docs/unit-of-work) e [alternativa TypeORM](https://typeorm.io/docs/transactions/).

## Extensão de autenticação

Na entrada HTTP, `APP_GUARD` registra `HttpAuthGuard`, que delega ao provider substituível `NoAuthGuard`, sem verificar credenciais ou criar identidade autenticada. A exceção explícita para `HealthController` ocorre antes da delegação, mantendo health público na futura integração com IdP. `providerId` informado não é identidade verificada. SQS é canal interno confiável conforme o desafio, mantendo as validações de domínio.

Desenho futuro: IdP externo emite tokens OAuth 2.0 Client Credentials para os provedores. Um Guard valida assinatura, expiração, emissor, audiência e autorização para o provedor/operação por um adaptador de identidade. Uma porta como `ProviderIdentityPort` separaria essa integração do domínio. Produto, biblioteca e contrato exato ficam para depois. Referências: [Guards](https://docs.nestjs.com/guards) e [Client Credentials](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.4).

## Pendências e propostas

- **Money:** mapeamento de persistência, reconstrução de valores internos com sinal e regras de zero nas demais operações de negócio. A implementação em memória não escolhe o tipo da coluna no banco nem restringe a aplicação a BRL.
- **Concorrência:** implementar o lock pessimista aceito e definir timeouts, ordem dos locks e tratamento de deadlocks. O lock não resolve sozinho conflitos de idempotência entre wallets; comprovar disputa na mesma carteira e paralelismo entre carteiras em pelo menos três processos.
- **Schema:** projetar unicidade, não negatividade, ledger imutável, reversões e inbox conforme seções 5 e 6 do desafio. Correspondência entre saldo e ledger exige proteção entre tabelas; um CHECK isolado não basta.
- **Contratos e regras:** hash canônico; referências opcionais ou ainda pendentes/rejeitadas; BET revertida por REFUND e ROLLBACK; estados, códigos de falha e respostas HTTP.
- **Workers e processos:** definir entradas API/workers, destino dos eventos, claim e recuperação da outbox, backoff, TTL/tentativas de referências, DLQ e shutdown.
- **Consultas:** snapshot consistente da reconciliação e cursor estável do ledger.

Pendências não são decisões aceitas. Registrar a escolha, motivo, alternativa e custo quando resolvidas; atualizar [testes](testing.md) com evidências e limitações.
