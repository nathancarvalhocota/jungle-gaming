# Fluxo financeiro persistente

Estado: execução incremental. Wallet, abertura auditável, BET/WIN/LOSS/REFUND/ROLLBACK e ledger paginado compõem a base `0411cd5`. O ticket 08 (reconciliação) está implementado e revisado. Esta entrega continua parcial; os blocos de mensageria descritos como continuidade permanecem pendentes.

WIN/LOSS e referências opcionais usam a mesma API e transação SQL. Políticas confirmadas, alternativas e limites estão em [arquitetura](../architecture.md#win-loss-e-referências-opcionais). Persistir PENDING_REFERENCE não implementa o worker de reprocessamento.

## Problema

Os provedores precisam submeter operações financeiras sem cobrar uma aposta duas vezes, perder créditos ou produzir saldo negativo quando houver reenvios, falhas e processamento concorrente. O operador precisa consultar um resultado auditável e conferir o saldo contra o ledger.

Existem bootstrap, extensão de autenticação, domínio financeiro, schema, repositórios, unidade de trabalho e HTTP para Wallet, abertura auditável e BET/WIN/LOSS/REFUND/ROLLBACK. Ledger paginado e reconciliação também estão implementados. Evidências reais e seus limites estão em [testes](../testing.md). Reversões integrais seguem as políticas aceitas de [REFUND](../architecture.md#refund-integral) e [ROLLBACK](../architecture.md#rollback-integral).

## Solução

Entregar o núcleo financeiro persistente do módulo wagering e sua entrada HTTP, com PostgreSQL como garantia compartilhada entre instâncias. A mesma operação deve produzir um único efeito financeiro, guardar seu resultado e confirmar transação, saldo, lançamento e intenção de evento atomicamente.

A entrega inclui criação de carteira, processamento de BET, WIN, LOSS, REFUND e ROLLBACK, consultas e reconciliação. Referência ainda ausente deve ficar pendente, sem movimentação antecipada. A gravação da outbox pertence a este núcleo; consumidor SQS, publicação e recuperação por workers serão entregas posteriores que reutilizarão esse processamento.

Esta especificação sintetiza requisitos e decisões; não afirma que todo o comportamento já foi implementado nem substitui as políticas ainda pendentes.

## Histórias de usuário

1. Como integrador, quero criar uma Wallet em BRL para manter o saldo de um jogador em uma moeda definida.
2. Como integrador, quero abrir uma Wallet com saldo zero para começar sem movimentação financeira fictícia.
3. Como operador, quero que saldo inicial positivo tenha OPENING e crédito no ledger para reconstruir o saldo desde sua origem.
4. Como integrador, quero receber conflito ao criar outra Wallet para o mesmo jogador e moeda para evitar carteiras duplicadas.
5. Como integrador, quero enviar dinheiro como string de duas casas para preservar sua precisão da entrada à resposta.
6. Como integrador, quero que formatos inválidos, moedas indisponíveis e valores fora do limite sejam recusados para não processar contratos ambíguos.
7. Como provedor, quero submeter uma BET para debitar uma aposta quando houver saldo suficiente.
8. Como jogador, quero que uma BET sem saldo seja rejeitada sem débito para preservar minha carteira.
9. Como provedor, quero submeter WIN para creditar um prêmio conforme as regras da operação.
10. Como provedor, quero registrar LOSS sem alterar saldo ou gerar lançamento para manter o resultado da rodada auditável.
11. Como provedor, quero que OPENING não possa ser submetida externamente para impedir crédito de abertura indevido.
12. Como provedor, quero devolver integralmente uma BET processada por REFUND para registrar sua compensação.
13. Como provedor, quero reverter uma operação elegível por ROLLBACK para aplicar seu efeito financeiro inverso.
14. Como operador, quero validar provedor, jogador, Wallet, moeda e rodada da referência para impedir reversões de outra operação.
15. Como operador, quero impedir reversão parcial e duplicidade pelo mesmo tipo para preservar as regras do desafio.
16. Como provedor, quero que uma reversão sem saldo seja rejeitada com código distinto do de BET sem saldo para tratar os casos corretamente.
17. Como provedor, quero que referência ausente gere PENDING_REFERENCE para não perder uma operação entregue fora de ordem.
18. Como provedor, quero repetir a mesma chave e conteúdo sem novo efeito financeiro para recuperar uma resposta perdida.
19. Como provedor, quero receber o saldo observado no processamento original, mesmo após outras movimentações, para reconhecer o resultado do reenvio.
20. Como integrador, quero que uma chave global reutilizada com conteúdo diferente gere conflito para detectar inconsistência de envio.
21. Como operador, quero que a mesma operação externa com outra chave gere conflito para impedir duplicação por troca de chave.
22. Como operador, quero que duplicatas simultâneas sejam resolvidas pelo PostgreSQL para manter a garantia entre processos.
23. Como jogador, quero que duas apostas disputando o mesmo saldo produzam apenas os débitos que posso pagar para não ficar com saldo negativo.
24. Como operador, quero processar Wallets diferentes em paralelo para não bloquear toda a aplicação por uma carteira disputada.
25. Como operador, quero preservar a correção com pelo menos três instâncias para não depender de memória de um processo.
26. Como operador, quero confirmar operação, saldo, lançamento e outbox juntos para evitar gravações financeiras parciais.
27. Como operador, quero que uma falha entre gravações desfaça toda a tentativa para preservar o estado anterior.
28. Como operador, quero guardar eventos de processamento, rejeição, pendência e mudança efetiva de saldo para futura publicação confiável.
29. Como integrador, quero consultar a Wallet e seu saldo atual para conhecer o estado disponível.
30. Como integrador, quero consultar uma transação pelo identificador interno ou pela identidade externa para recuperar seu resultado auditável.
31. Como operador, quero paginar o ledger com cursor estável e opaco para consultar o histórico sem perdas ou duplicações indevidas.
32. Como operador, quero impedir alteração, exclusão ou limpeza do ledger por comandos comuns de SQL para preservar o histórico financeiro.
33. Como operador, quero reconstruir o saldo pelo ledger para identificar divergências com o saldo armazenado.
34. Como operador, quero que divergências sejam informadas sem correção silenciosa para permitir investigação auditável.
35. Como integrador, quero distinguir contrato inválido, conflito, rejeição financeira, pendência e falha transitória para decidir se devo corrigir ou reenviar.
36. Como mantenedor, quero aplicar, reverter e reaplicar migrations e suas proteções para reproduzir a instalação e verificar sua reversibilidade.

## Decisões de implementação

### Requisitos obrigatórios do desafio

- Manter classes encapsuladas, construtores privados/protegidos e factories; reconstrução chama rehydrate sem reaplicar transições.
- Aplicar unicidade de Wallet por jogador/moeda, no máximo um lançamento por transação/Wallet, imutabilidade do ledger e não negatividade também no schema.
- Wallet começa na versão 1 e incrementa somente quando seu saldo muda; abertura positiva não pode incrementar a versão novamente ao registrar sua auditoria.
- OPENING é interna; abertura positiva confirma Wallet, OPENING e CREDIT juntos. Abertura zero não deve produzir lançamento zero.
- BET debita, WIN credita, LOSS não movimenta, REFUND compensa BET processada e ROLLBACK inverte BET, WIN ou REFUND processada. Referências obrigatórias, compatibilidade e valor integral seguem o enunciado; não assumir que toda referência informada já está processada.
- Transações nascem PENDING. PROCESSED, REJECTED e FAILED são terminais; tentar alterá-las novamente é erro de programação. Referência ausente produz PENDING_REFERENCE e intenção de evento, sem lançar ou mudar saldo.
- Rejeições financeiras são resultados persistidos com failureCode; não usar exceção genérica de infraestrutura como rejeição de negócio. Falha abortiva provoca rollback, sem transformar indisponibilidade em referência inexistente.
- Idempotency-Key é obrigatório no HTTP. Hash usa JSON canônico dos campos de negócio, excluindo chave e metadados de transporte; BET usa SHA-256 dos oito campos obrigatórios com chaves recursivamente ordenadas; detalhes e HTTP estão em [arquitetura](../architecture.md#bet-idempotente-e-concorrente).
- Outbox persiste o envelope versionado dos eventos exigidos, com classe abstrata e subclasses concretas. Dinheiro no payload usa strings; não serializar a instância de Money nem bigint no JSON.
- Registrar WagerTransactionProcessed inclusive para LOSS, WagerTransactionRejected para rejeição, WagerTransactionPendingReference para pendência e WalletBalanceChanged somente quando houver mudança de saldo.
- Consulta e reconciliação seguem os contratos do desafio. Divergência não pode ser corrigida silenciosamente; sua sinalização em resposta, log e métrica não é opcional.

### Decisões já aceitas

| Tema | Direção acordada e consequência |
| --- | --- |
| Fronteira financeira | Wallet, WagerTransaction e ledger no mesmo módulo wagering e PostgreSQL; responsabilidades internas distintas, sem serviços distribuídos adicionais |
| Mapeamento | Schemas MikroORM sem classes espelhadas; tipos inferidos e conversão no repositório. O ORM acompanha registros de persistência; o repositório sincroniza o estado de domínio e chama rehydrate |
| Dinheiro | bigint em centésimos no domínio e PostgreSQL, moeda separada e nomes explícitos da unidade; nunca passar valores monetários por number |
| Formato e limite | Strings estritas com duas casas, ponto e sem separador de milhar; magnitude inclusiva de 1000000.00, centralizada em Money e reforçada por constraints nos campos financeiros correspondentes |
| Moedas | Modelo reconhece BRL e USD, mas a aplicação oferece somente BRL; não há conversão cambial |
| Movimentação | Wallet produz o lançamento antes de atualizar seu estado; falhas preservam saldo, versão e data. Débito, crédito e criação de lançamento rejeitam zero; abertura zero continua permitida |
| Transação SQL | Caso de uso delimita unidade de trabalho; repositórios usam o mesmo EntityManager transacional, inclusive QueryBuilder e SQL explícito. Não abrem commits independentes |
| Concorrência | SELECT FOR UPDATE na linha da Wallet antes de decidir sobre saldo, mantido até commit/rollback. Transação curta, sem chamadas externas; sem lock global |
| Idempotência | Chave globalmente única no PostgreSQL; mesma chave e payload igual recuperam o resultado persistido; conteúdo divergente gera conflito |
| Identidade externa | Par provedor/identificador externo único; reenvio dessa operação com outra chave gera conflito |
| Resultado original | Guardar na própria transação os dados necessários para repetir a resposta, inclusive saldo observado, moeda, status e falha quando aplicável; não consultar o saldo atual para fabricar replay |
| Disputa pela chave | QueryBuilder com inserção que ignora conflito da chave e retorna o identificador inserido; se não inserir, consultar o vencedor em comando seguinte sob READ COMMITTED. Não sobrescrever o resultado existente por upsert |
| Imutabilidade | Triggers bloqueiam UPDATE, DELETE e TRUNCATE no ledger, criados e removidos por migrations. Papel restrito separado fica para depois; administrador/proprietário pode remover as proteções |
| Coerência saldo/ledger | Domínio produz ambos e unidade de trabalho persiste atomicamente; não somar o histórico em trigger a cada commit. SQL isolado que altere saldo pode causar divergência; não alegar bloqueio desse cenário pelo schema |
| Evolução | Entregas e commits pequenos, isolados e revisados; aprovação desta spec não autoriza implementar todos os blocos ou fazer commits |

### Contratos HTTP abrangidos

| Operação | Contrato do desafio |
| --- | --- |
| Criar Wallet | POST /wallets |
| Consultar Wallet | GET /wallets/:walletId |
| Submeter transação | POST /wagering/transactions, com Idempotency-Key |
| Consultar transação interna | GET /wagering/transactions/:transactionId |
| Consultar identidade externa | GET /providers/:providerId/wagering/transactions/:externalTransactionId |
| Consultar ledger | GET /wallets/:walletId/ledger, com cursor e limite |
| Reconciliar | POST /wallets/:walletId/reconciliation |

Preservar o ponto de extensão de autenticação existente e health público. providerId recebido continua sem identidade autenticada; não inventar verificação de credenciais.

## Decisões de testes

Fronteira principal confirmada: caso de uso financeiro real com PostgreSQL real em container. Complementar com poucos testes HTTP completos, SQL direto para proteções do schema e testes unitários de domínio. Evitar duplicar a mesma matriz em todas as camadas.

- Um bom teste verifica resultado observável, estado persistido e ausência de efeitos extras; não exige uma sequência privada de chamadas ao ORM.
- Preservar os testes existentes de Money, Wallet e WalletLedgerEntry. Acrescentar regras de WagerTransaction, estados terminais, referências, códigos de falha e hash conforme políticas confirmadas.
- Reutilizar o precedente de banco descartável, migrations reais e conexão observadora independente da suíte de compatibilidade. Não escrever sobre o banco de desenvolvimento nem usar mocks como prova de atomicidade.
- No percurso de ida e volta, verificar centésimos, moeda, limites e reconstrução por factories sem executar movimentos novamente.
- Demonstrar abertura positiva com saldo reconstruível, versão 1 e um crédito; abertura zero sem lançamento. Disputar criação duplicada por jogador/moeda.
- Tentar violar unicidades, limites e não negatividade com SQL direto; tentar alterar, excluir e truncar o ledger. Aplicar, reverter e reaplicar as migrations e seus triggers.
- Provocar falha entre gravações e observar por conexão independente que nenhuma alteração parcial sobrevive, inclusive outbox.
- Repetir uma aposta 50 vezes em paralelo: um débito, um lançamento e apenas as intenções de evento da execução original. Retornar o resultado original após outras movimentações.
- Disputar a mesma chave com payload divergente e a mesma operação externa com outra chave; verificar conflitos sem efeitos financeiros adicionais.
- Disputar duas BET de 80.00 sobre saldo 100.00: uma processada, outra rejeitada por saldo insuficiente, saldo final 20.00 e exatamente um débito.
- Provar que Wallets diferentes avançam sem lock global e executar disputas com pelo menos três processos reais. Promises em um único processo não demonstram esse requisito.
- Verificar compensação integral, referências incompatíveis, referência ainda pendente/rejeitada e reversões concorrentes conforme decisões fechadas antes dos tickets correspondentes.
- No HTTP, testar ligação com o caso de uso, validação runtime, header obrigatório, moeda BRL e distinção entre categorias de resposta; usar aplicação e PostgreSQL reais.
- Reconciliar sob concorrência em um único SELECT com snapshot MVCC; barreira somente de teste comprova commit financeiro durante a consulta. Sinalizar divergência provocada em resposta, JSON sem montantes e contador Prometheus, sem corrigi-la. Conferir saldo contra ledger em todos os cenários financeiros.
- Executar typecheck, lint e testes pertinentes por entrega; registrar ambiente, comandos, falhas e limites. Antes de concluir o fluxo, executar a suíte completa.

## Fora do escopo

- Login, usuários, integração com Identity Provider ou substituição do ponto de extensão existente.
- Adaptador consumidor SQS, inbox de transporte, ack, visibilidade, retry, DLQ e shutdown de mensagens; são requisitos de uma entrega posterior, não dispensas do desafio.
- Publicador da outbox, claim concorrente, recuperação de publicação e prova de entrega no broker; a intenção de evento deve ser persistida agora, mas sua publicação não será alegada como pronta.
- Worker agendado de referências, TTL e backoff. Esta etapa persiste a pendência; o requisito de reprocessamento e expiração só ficará completo com o worker posterior.
- Readiness PostgreSQL/SQS e suíte completa de métricas/logs operacionais de mensageria. A sinalização de reconciliação abrangida acima permanece exigida neste fluxo.
- Câmbio, moedas adicionais disponíveis no produto, reversões parciais, partidas dobradas, dashboards, OpenTelemetry e carga opcional.
- Trigger de soma do ledger no commit, novas classes espelhadas de persistência e configuração de papel restrito separado.
- Alterar o enunciado original, instalar dependências sem pesquisa/validação ou fazer commit sem autorização.

## Notas adicionais

### Políticas ainda não decididas

As escolhas abaixo precisam ser resolvidas antes do ticket que depende delas. Não são autorização para o agente selecionar silenciosamente regras de negócio; partes independentes podem avançar quando delegadas.

| Pendência | Impacto |
| --- | --- |
| Referências — resolvido | BET preserva hash original; WIN/LOSS incluem referência somente quando informada. REFUND/ROLLBACK exigem referência e a incluem no hash |
| Transições, failureCodes e HTTP | BET/WIN/LOSS/REFUND/ROLLBACK distinguem processamento, rejeição e pendência; FAILED permanece inalcançável. Débito inverso sem saldo gera REVERSAL_INSUFFICIENT_FUNDS |
| Zero — resolvido | BET/WIN/REFUND/ROLLBACK zero retornam 400; LOSS aceita zero informativo |
| Compensações diretas — resolvido | No máximo uma PROCESSED por referência entre REFUND/ROLLBACK. ROLLBACK inverte BET/WIN/REFUND processada com valor exato; reverter REFUND não reabre a BET |
| Ordem dos locks — resolvido para reversões | Wallet antes de claim/referência, sem outro lock na referência; consulta de compensações no mesmo contexto. READ COMMITTED e limites existentes; conflito específico do índice só após rollback produz 503, sem retry interno |
| Identificadores e metadados internos de OPENING — resolvido | UUID interno, origem INTERNAL e campos externos ausentes; unicidades externas não usam sentinelas |
| Evolução posterior de PENDING_REFERENCE | Snapshot persistido e replay sem reprocessar estão implementados; worker, TTL e backoff permanecem pendentes |
| Ledger paginado — resolvido | Keyset `created_at DESC, id DESC`; cursor v1 base64url vinculado à Wallet e âncora SQL imutável, sem snapshot; limite decimal estrito padrão 50, entre 1 e 100. Contrato e custos em [arquitetura](../architecture.md#ledger-paginado) |
| Reconciliação — resolvido | Um SELECT parametrizado agrega Wallet e ledger no mesmo snapshot, sem lock financeiro. Diagnóstico usa bigint e strings assinadas de duas casas sem teto de Money; diferença é armazenado menos calculado. JSON de divergência sem montantes e dois contadores locais em GET /metrics; detalhes e custos em [arquitetura](../architecture.md#reconciliação) |
| Destino e políticas dos futuros workers | Publicação, reprocessamento e recuperação são obrigatórios na continuidade |

### Ordem de decomposição

Tickets verticais aprovados: criar/consultar Wallet zero; abertura positiva auditável; BET idempotente e concorrente; WIN/LOSS e referências; REFUND; ROLLBACK; ledger paginado; reconciliação. Cada um inclui domínio, schema, persistência, HTTP e testes necessários ao comportamento, sem tickets separados apenas por camada. Ledger paginado e reconciliação dependem da abertura auditável, sem esperar artificialmente os demais kinds. Dependências e decisões pendentes ficam explícitas no rastreador local; cada entrega exige revisão antes da próxima e não autoriza commit automaticamente.

### Referências e estado inicial

- Requisitos: [desafio](../challenge.md), principalmente seções 5 a 9, 11 e 13.
- Decisões e custos: [arquitetura](../architecture.md); vocabulário: [glossário](../glossary.md).
- Estratégia e evidências existentes: [testes](../testing.md); organização: [estrutura](../structure.md).
- Base revisada: commit ef023d9, com 120 testes e 463 asserções. Essa evidência não comprova o fluxo financeiro persistente descrito aqui.
- Por solicitação do candidato, esta spec fica nos documentos versionáveis. O rastreador local guarda apenas referência, sem duplicar o conteúdo. Nenhum commit é criado pela elaboração da spec.
