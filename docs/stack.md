# Stack

## Requisitos

O [desafio](challenge.md), seção 4, exige Bun 1.x como runtime, gerenciador de pacotes e executor de testes; TypeScript estrito; NestJS; PostgreSQL; AWS SQS via LocalStack ou MiniStack; Docker Compose; e migrations versionadas e reversíveis. MikroORM é preferencial e TypeORM é permitido. A escolha por MikroORM está em [arquitetura](architecture.md).

## Base validada

| Tecnologia | Versão | Responsabilidade | Fonte oficial |
| --- | --- | --- | --- |
| Bun | 1.4.4 | Executar aplicação, instalar pacotes e rodar testes | [Release](https://bun.sh/blog/bun-v1.4.4) |
| NestJS | 12.2.0 | Composição, injeção de dependências e HTTP | [Releases](https://github.com/nestjs/nest/releases) |
| MikroORM | 7.2.5 | Mapeamento, acompanhamento de alterações, transações e migrations | [Versões](https://mikro-orm.io/versions) |
| Integração NestJS/MikroORM | 7.1.0 | Conectar o ORM à composição NestJS | [Integração](https://mikro-orm.io/docs/usage-with-nestjs) |
| TypeScript | 7.0.2 | Verificação estática em modo estrito | [Documentação](https://www.typescriptlang.org/tsconfig/) |
| PostgreSQL | 18.6 | Persistência SQL transacional | [Versões suportadas](https://www.postgresql.org/support/versioning/) |
| MiniStack | 1.5.32 | Emular SQS localmente | [Release](https://github.com/ministackorg/ministack/releases/tag/v1.5.32) |
| Biome | 2.6.3 | Lint e formatação TypeScript/JSON | [Documentação](https://biomejs.dev/guides/getting-started/) |

As versões efetivamente instaladas são definidas por [package.json](../package.json) e [bun.lock](../bun.lock). As imagens ficam em [compose.yaml](../compose.yaml). A tabela registra a combinação validada, sem substituir essas fontes.

## Compatibilidade

- Os guias de [NestJS](https://docs.nestjs.com/migration-guide) e [MikroORM 7](https://mikro-orm.io/docs/upgrading-v6-to-v7) descrevem requisitos Node.js. Os testes locais com Bun demonstram apenas o caminho exercitado, sem estabelecer suporte completo de runtime.
- `@mikro-orm/nestjs` 7.1.0 declara peer dependencies compatíveis com NestJS 12 e MikroORM 7. Core, driver PostgreSQL e migrations usam a mesma versão MikroORM.
- O projeto usa ESM e resolução `Bundler`, com decorators legados e `emitDecoratorMetadata` para NestJS. Não foi necessário usar o CLI Nest para gerar ou executar o bootstrap.
- Schemas de teste são registrados explicitamente por `EntitySchema`. O guia MikroORM aponta ressalva de discovery por glob no Bun; esse caminho não foi usado.
- Bun executa código e testes. A verificação estrita de tipos usa `tsc --noEmit`, separadamente do runtime.
- PostgreSQL usa a imagem `postgres:18.6-bookworm`. Docker Engine 29.9.2 e Compose 5.6.1 estavam disponíveis no ensaio. Node 24.13 estava instalado, mas não executou a aplicação ou os testes.

O ensaio validou HTTP, conexão, migrations reversíveis, commit, rollback, uma constraint e transporte decimal. O mapeamento financeiro definitivo, precisão de `Money`, concorrência e integração SQS continuam pendentes. MiniStack está em execução local, mas FIFO e DLQ ainda não foram verificados pela suíte. Ver [evidências](testing.md).
