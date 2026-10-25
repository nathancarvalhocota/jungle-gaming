# Rastreador de tarefas: Markdown local

Demandas, especificações e tickets deste repositório ficam em arquivos Markdown sob `.scratch/`.

## Convenções

- Use um diretório por iniciativa: `.scratch/<feature-slug>/`.
- Salve a especificação em `.scratch/<feature-slug>/spec.md`.
- Salve cada ticket em `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numerado a partir de `01`; não reúna vários tickets em um único arquivo.
- Registre a situação numa linha `Status:` perto do início do ticket, usando os valores mapeados em `triage-labels.md`.
- Acrescente comentários e histórico ao final do arquivo, sob `## Comentários`.

## Publicar e consultar

- Para publicar uma especificação, crie um arquivo no diretório da iniciativa.
- Para publicar tickets, crie um arquivo por ticket.
- Para consultar um ticket, leia o arquivo indicado pelo usuário ou pelo número informado.

## Operações do Wayfinder

- Mapa: `.scratch/<effort>/map.md`.
- Ticket filho: `.scratch/<effort>/issues/<NN>-<slug>.md`.
- Use `Type:` para `research`, `prototype`, `grilling` ou `task`.
- Use `Status:` para `claimed` ou `resolved`.
- Registre dependências em `Blocked by: NN, NN`.
- Um ticket está livre quando todos os arquivos listados em `Blocked by` estão com status `resolved`.
- Para reivindicar um ticket, mude seu status para `claimed` antes de começar.
- Para resolvê-lo, acrescente a resposta sob `## Answer`, mude o status para `resolved` e atualize a seção de decisões do mapa.
