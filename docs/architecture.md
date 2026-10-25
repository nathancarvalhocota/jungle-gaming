# Arquitetura

Requisitos obrigatórios estão no [desafio](challenge.md). Esta página registra escolhas e pendências; versões ficam em [stack](stack.md), arquivos em [estrutura](structure.md) e evidências em [testes](testing.md). A base técnica foi validada; as garantias financeiras ainda não foram implementadas.

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
| Autenticação | Fora do escopo; prioriza correção financeira e preserva extensão futura | Sem verificação de identidade ou autorização HTTP nesta entrega; alternativa: integrar IdP agora |
| Inicialização | Conectar PostgreSQL antes de abrir HTTP; liveness responde sem consultar dependências | Aplicação não inicia sem banco. Iniciar em estado não pronto exigiria desenho adicional de recuperação |

O bootstrap concentra a inicialização em `src/main.ts`, importável pelos testes sem iniciar o servidor. Liveness retorna diretamente no controller. A árvore e suas propostas estão em [estrutura](structure.md).

O limite de `Money` está centralizado em `MAX_MINOR_UNITS`, validado pelo construtor privado na criação e em todos os resultados aritméticos. Entradas externas não aceitam negativos; valores internos podem variar de `-1000000.00` a `1000000.00` para suportar negação e diferenças. O limite é nominal na moeda do objeto, sem conversão cambial. Excedê-lo gera erro de domínio, sem truncamento ou arredondamento; não há limites diferentes por aposta, depósito ou saque definidos nesta decisão. A classe é imutável em runtime e lança `MoneyError` para entradas, moedas ou resultados inválidos. `toString()` usa o formato `25.00 BRL`; `toJSON()` retorna strings com duas casas, inclusive sinal para resultados negativos. Não há factory pública de reidratação.

## Contrato transacional aceito

O caso de uso delimita uma transação por `em.transactional(...)`, encapsulado no adaptador da unidade de trabalho. Estado da operação, saldo, ledger, inbox quando aplicável e outbox usam o mesmo EntityManager, inclusive para SQL explícito. Repositórios não abrem transações independentes nem fazem commits próprios; domínio e caso de uso não dependem do ORM.

Cada requisição, mensagem ou trabalho usa contexto isolado. Falhas que abortam a operação propagam para rollback; rejeições de negócio são persistidas como resultados auditáveis, sem movimentação indevida. O replay deve recuperar o resultado original, incluindo o saldo observado naquele processamento.

Publicação SQS e confirmação da mensagem recebida ocorrem após commit. A outbox guarda a intenção atomicamente; publicação pode repetir após falha, exigindo deduplicação pela identidade estável do evento. Atomicidade não substitui concorrência, idempotência ou constraints.

A API e o consumidor SQS reutilizarão o mesmo caso de uso. A composição de wallet, transações e ledger em um módulo financeiro continua proposta; não implica serviços ou transações independentes. Contratos dos repositórios e implementação da unidade de trabalho continuam pendentes. Os testes atuais comprovam apenas o mecanismo SQL em tabelas de ensaio.

Referências: [transações MikroORM](https://mikro-orm.io/docs/transactions), [contexto isolado](https://mikro-orm.io/docs/identity-map), [Unit of Work](https://mikro-orm.io/docs/unit-of-work) e [alternativa TypeORM](https://typeorm.io/docs/transactions/).

## Extensão de autenticação

Na entrada HTTP, `APP_GUARD` registra `HttpAuthGuard`, que delega ao provider substituível `NoAuthGuard`, sem verificar credenciais ou criar identidade autenticada. A exceção explícita para `HealthController` ocorre antes da delegação, mantendo health público na futura integração com IdP. `providerId` informado não é identidade verificada. SQS é canal interno confiável conforme o desafio, mantendo as validações de domínio.

Desenho futuro: IdP externo emite tokens OAuth 2.0 Client Credentials para os provedores. Um Guard valida assinatura, expiração, emissor, audiência e autorização para o provedor/operação por um adaptador de identidade. Uma porta como `ProviderIdentityPort` separaria essa integração do domínio. Produto, biblioteca e contrato exato ficam para depois. Referências: [Guards](https://docs.nestjs.com/guards) e [Client Credentials](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.4).

## Pendências e propostas

- **Money:** mapeamento de persistência, reconstrução de valores internos com sinal e tratamento de valores zero por operação. A implementação em memória não escolhe o tipo da coluna no banco nem restringe a aplicação a BRL.
- **Concorrência:** proposta de lock pessimista por wallet; alternativa otimista com retry limitado. Definir timeouts, ordem dos locks e deadlocks. O lock não resolve sozinho conflitos de idempotência entre wallets.
- **Schema:** projetar unicidade, não negatividade, ledger imutável, reversões e inbox conforme seções 5 e 6 do desafio. Correspondência entre saldo e ledger exige proteção entre tabelas; um CHECK isolado não basta.
- **Contratos e regras:** escopo da chave, hash canônico e identificador externo repetido; referências opcionais ou ainda pendentes/rejeitadas; BET revertida por REFUND e ROLLBACK; estados, códigos de falha e respostas HTTP.
- **Workers e processos:** definir entradas API/workers, destino dos eventos, claim e recuperação da outbox, backoff, TTL/tentativas de referências, DLQ e shutdown.
- **Consultas:** snapshot consistente da reconciliação e cursor estável do ledger.

Pendências não são decisões aceitas. Registrar a escolha, motivo, alternativa e custo quando resolvidas; atualizar [testes](testing.md) com evidências e limitações.
