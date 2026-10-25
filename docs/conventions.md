# Convenções de código

## Referência

Consultar [estrutura](structure.md) para localizar código e [arquitetura](architecture.md) para decisões e limites.

## Princípios

- SOLID: responsabilidades claras, estado encapsulado e dependências voltadas para contratos pequenos nas fronteiras necessárias.
- Clean Code: nomes expressivos, funções focadas e ausência de código morto.
- DRY: compartilhar a mesma regra, evitando abstrações criadas apenas por semelhança de código.
- Regras de negócio compartilhadas ficam no domínio; coordenação, nos casos de uso; particularidades de HTTP e SQS, nos adaptadores.
- Introduzir abstrações conforme necessidade demonstrada; evitar repositório genérico ou mediator sem benefício concreto.

## Dependências

- Domínio usa conceitos de domínio e bibliotecas puras necessárias.
- Aplicação usa domínio e portas; detalhes SQL/SQS ficam nos adaptadores.
- Módulos NestJS fazem a composição de providers e tokens.
- Repositórios participam da unidade de trabalho; não confirmam independentemente uma operação financeira.
- Avaliar registros ORM e mappers separados para preservar construtores e rehydrate; justificar a duplicação necessária.
- Shared recebe apenas conceitos cujo uso por mais de uma funcionalidade tenha sido demonstrado.

## Idioma e nomenclatura

- Código, identificadores e comentários em inglês.
- Documentação em português com acentuação correta e codificação UTF-8; preservar nomes técnicos e contratos externos.
- Arquivos kebab-case, tipos PascalCase e membros camelCase. Usar os sufixos de responsabilidade do NestJS quando aplicáveis, como `.module.ts` e `.controller.ts`.

## Comentários

- Preferir nomes e estrutura que expressem a intenção sem comentários.
- Comentar apenas comportamentos, riscos ou invariantes que o código não revela.
- Quando necessário, escrever uma linha em inglês; decisões extensas ficam em [arquitetura](architecture.md).
- Comentários não registram histórico de refatoração nem repetem o código.

## TypeScript e contratos

- Ativar strict e verificações adicionais úteis, como noUncheckedIndexedAccess.
- Usar unknown para entradas externas e erros, com validação/narrowing.
- Validar entradas externas em runtime; evitar casts usados apenas para silenciar o compilador.
- DTOs podem ser interfaces/tipos; invariantes ficam em classes encapsuladas.
- Usar readonly e considerar também mutabilidade de objetos aninhados e Date.
- Usar tokens/factories para interfaces apagadas em runtime.
- No bootstrap validado, usar ESM, resolução `Bundler`, decorators legados e `emitDecoratorMetadata` para NestJS sob Bun. Imports de classes usados na metadata de injeção precisam existir em runtime; não convertê-los automaticamente para `import type`.

## Erros e operação

- Distinguir rejeição financeira persistida, erro de contrato, conflito e indisponibilidade.
- Uma falha de consulta não significa referência inexistente.
- Tratar ou propagar exceções preservando sua causa; evitar `catch` vazio e logs duplicados do mesmo erro.
- Registrar contexto estruturado sem payload financeiro completo ou credenciais.
- Parametrizar SQL e validar configuração no startup.
- Separar identidade de negócio de metadados de transporte.

## Operações assíncronas

- Aguardar promises ou definir explicitamente como suas falhas serão tratadas.
- Usar `Promise.all` apenas para operações independentes cujo paralelismo seja seguro.
- Preservar a ordem exigida entre gravações e o contexto transacional compartilhado.

## Ferramentas e Git

- Usar Bun e versionar um único lockfile após instalar dependências.
- Fixar runtime, dependências e imagens após verificar compatibilidade.
- Manter commits por objetivo; mudanças funcionais acompanham testes e documentação relevante.
- Excluir segredos, configurações locais e saídas geradas do commit; versionar `.env.example` sem credenciais reais.

## Antes de concluir uma tarefa

- Para alterações de código, executar `bun run typecheck`, `bun run lint` e os testes pertinentes. Antes do primeiro commit e da entrega, executar a suíte completa com `bun run test`.
- `bun run format` aplica formatação e correções seguras; revisar o diff resultante.
- Para mudanças apenas documentais, conferir links, consistência e diff.
- Informar comandos executados, falhas e cenários não verificados; distinguir implementação de garantias demonstradas.
- Atualizar as decisões em [arquitetura](architecture.md) e as evidências em [testes](testing.md) quando afetadas.
