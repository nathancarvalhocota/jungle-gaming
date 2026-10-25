# Acordo de trabalho

Implementar [challenge.md](docs/challenge.md), preservando o enunciado original.

## Contexto

- Antes de implementar, ler [architecture.md](docs/architecture.md) para conhecer o estado das decisões e os limites.
- Para organização de arquivos, consultar [docs/structure.md](docs/structure.md); para regras de código, [docs/conventions.md](docs/conventions.md).
- Para alterações financeiras, de persistência ou workers, ler [docs/testing.md](docs/testing.md) e as seções pertinentes do desafio.
- Para ordem de entrega, consultar `docs/roadmap.md` quando existir; é apoio local não versionado. Requisitos e decisões permanecem nos documentos versionados.
- Antes de escolher dependências, consultar [docs/stack.md](docs/stack.md) e a pesquisa local em `docs/research/` quando disponível; verificar a documentação oficial das versões selecionadas.

## Colaboração

- Explicar escolhas arquiteturais em português, uma decisão por vez, com alternativas e recomendação. O candidato participa das decisões que afetam garantias, escopo ou limites antes da implementação.
- Resolver detalhes mecânicos de forma autônoma. Registrar decisões acordadas em docs/architecture.md; manter propostas separadas das decisões aceitas.
- Trabalhar dentro da etapa acordada. Entregar um comportamento completo, mostrar evidências dos testes e explicar as garantias.
- Escrever documentação, incluindo este arquivo, em português com acentuação correta e codificação UTF-8. Usar inglês nos identificadores e comentários do código; preservar nomes técnicos, comandos e contratos.

## Garantias financeiras

- Manter valores monetários exatos da entrada à persistência e à saída. Nunca convertê-los por number, parseFloat ou tipos de ponto flutuante no banco.
- Proteger concorrência por wallet e idempotência persistente no PostgreSQL; ordenação FIFO é uma otimização.
- Confirmar estado da transação, saldo, ledger, inbox quando presente e outbox atomicamente. Publicar e confirmar mensagens somente após o commit.
- Manter o ledger imutável no domínio e no schema. Aplicar unicidade e não negatividade exigidas no banco.
- Reutilizar o mesmo caso de uso para HTTP e SQS. Manter o domínio independente de tipos do NestJS e ORM.

## Conclusão

- Executar verificações pertinentes ao comportamento alterado. Para mudanças apenas documentais, conferir links, consistência e diff.
- Informar verificações executadas, falhas e cenários não verificados. Distinguir implementação de garantias demonstradas.
- Atualizar evidências dos requisitos e o estado das decisões. Manter limitações explícitas.
- Incluir no commit apenas arquivos pertinentes; excluir segredos, saídas geradas e arquivos de outros projetos.

## Agent skills

### Rastreador de tarefas

Demandas, especificações e tickets ficam em `.scratch/` como Markdown. Consulte `docs/agents/issue-tracker.md`.

### Rótulos de triagem

Use os rótulos padrão definidos em `docs/agents/triage-labels.md`.

### Documentação de domínio

Este é um repositório de contexto único. Consulte `docs/agents/domain.md` para as regras de leitura do glossário e dos ADRs.
