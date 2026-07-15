# Auditoria de dados (somente leitura)

Ferramenta local para inspecionar `wallets` e `tournaments` **antes** de fazer
deploy do backend endurecido, e descobrir quais documentos existentes o novo
código recusaria.

Ela **apenas relata**. Não corrige, não migra, não faz deploy, não escreve.

## Por que ela existe

O backend endurecido (`feature/backend-hardening`) passou a fazer toda a
aritmética financeira em **centavos inteiros** e a recusar valores monetários que
não sejam convertíveis com exatidão. Isso é o comportamento correto — mas
significa que uma carteira com um valor não representável em centavos deixará de
ser operável e retornará `failed-precondition` para o jogador.

**Um esclarecimento importante, fácil de entender ao contrário:** o *drift* de
ponto flutuante na escala de ULP **não** é um problema e **não** é sinalizado. Um
`balance` de `0.30000000000000004` (o que a aritmética antiga produzia para
`0.1 + 0.2`) ainda vale exatamente 30 centavos: o desvio é de ~4e-17, muito abaixo
da tolerância, e a conversão arredonda com segurança. Sinalizá-lo seria um falso
positivo sobre dinheiro saudável e afogaria os documentos realmente quebrados em
ruído.

O que de fato quebra é um valor **sub-centavo real** — `1/3`, o resultado de um
cálculo de juros como `10.1 * 1.07` (= `10.807`), ou três casas decimais
digitadas — além de `NaN`, `Infinity`, negativos, strings e campos ausentes.

O mesmo vale para torneios: documentos com os pares de participantes divergentes,
incompletos ou ausentes farão o `jointournament` recusar a inscrição.

**Esta auditoria descobre esses documentos antes do deploy**, quando ainda são um
item de planejamento e não um incidente em produção.

## Garantias de segurança

1. **Somente leitura, por tipo.** A camada de coleta recebe a coleção pela
   interface `ReadOnlyQuery`, que expõe apenas `orderBy`, `limit`, `startAfter` e
   `get`. Não existe `set`, `create`, `add`, `update`, `delete`, `batch`,
   `bulkWriter` nem `runTransaction` nesse tipo — uma escrita não é "proibida por
   convenção", ela é **irrepresentável**. Há um teste com um fake que explode se
   qualquer método de escrita for chamado.
2. **Recusa por padrão.** Sem `--project`, a ferramenta encerra. Ela **nunca** usa
   o projeto padrão do `.firebaserc` (que aponta para produção).
3. **O SDK só é carregado depois da aprovação.** `firebase-admin` é importado
   dinamicamente **após** o guard aprovar. Uma execução recusada nunca carrega o
   SDK, nunca resolve credencial e nunca abre conexão.
4. **Nenhum dado pessoal é impresso.** A camada de relatório só recebe ids e
   códigos de problema — ela não tem acesso ao corpo dos documentos, então não
   consegue imprimir e-mail, chave PIX, WhatsApp ou saldo nem por acidente.
5. **Ids só com opção explícita** (`--show-ids`), e a saída avisa para não
   commitar. `audit-reports/` está no `.gitignore`.
6. **Sem service account.** Nenhuma chave é criada, baixada ou armazenada.

## Comandos

### Contra o emulador local (seguro — use isto no desenvolvimento)

```bash
cd functions
npm run audit:data:emulator
```

### Contra produção (exige confirmação explícita)

```bash
cd functions
npm run audit:data -- --project sparta-battle --confirm-read-only-production-audit
```

Sem a flag longa, a ferramenta **recusa** e sai com código 1. Um id de projeto
diferente (inclusive um erro de digitação como `spartabattle`) também é recusado.

Para listar os documentos afetados, acrescente `--show-ids`. **Não commite essa
saída** — ids de wallet são ids de usuário.

### Códigos de saída

| Código | Significado |
|---|---|
| `0` | Auditoria executada, nenhuma anomalia |
| `2` | Auditoria executada, anomalias encontradas |
| `1` | Falha operacional **ou configuração insegura** (ex.: falta de confirmação) |

O código `1` nunca significa "os dados estão bons". Uma recusa jamais pode ser
confundida com uma auditoria limpa.

## BLOQUEIO ATUAL: não há credencial para ler produção

**A auditoria contra `sparta-battle` ainda não pode ser executada nesta máquina.**

O `firebase-admin` autentica via **Application Default Credentials (ADC)**. Hoje:

- `gcloud` **não está instalado**;
- não existem ADC em `%APPDATA%\gcloud\application_default_credentials.json`;
- `GOOGLE_APPLICATION_CREDENTIALS` não está definido;
- o login do **Firebase CLI** (`furlanamarocesarh@gmail.com`) **não serve**: ele
  autentica a CLI, não o Admin SDK.

Isso está documentado, e **não foi contornado**. Não criamos service account nem
baixamos chave.

### Como autenticar com segurança no futuro (sem service-account JSON)

Use **ADC de usuário**, que reaproveita a sua própria conta Google e as suas
permissões IAM. A credencial fica no perfil do usuário, tem validade curta e
**nunca entra no repositório**:

```bash
# 1. Instalar o Google Cloud CLI (uma vez).
winget install Google.CloudSDK

# 2. Autenticar como você mesmo. Isso NÃO cria service account nem baixa chave.
gcloud auth application-default login

# 3. Rodar a auditoria.
cd functions
npm run audit:data -- --project sparta-battle --confirm-read-only-production-audit
```

A conta usada precisa de permissão de **leitura** no Firestore
(`roles/datastore.viewer` é suficiente — não conceda papel de escrita para uma
ferramenta que só lê).

**Não** use `GOOGLE_APPLICATION_CREDENTIALS` apontando para um JSON de service
account. Essa chave é um segredo de longa duração, com acesso total ao projeto e
que ignora as regras do Firestore; ela vaza para o histórico do Git com
facilidade. O ADC de usuário entrega a mesma leitura sem criar esse ativo.

## O que a auditoria verifica

### Wallets

Os cinco campos monetários — `balance`, `total_deposited`, `total_won`,
`total_spent`, `total_withdrawn` — são inspecionados pela **mesma função**
(`inspectReais`, em `domain/money.ts`) que as Cloud Functions usam. Isso é
deliberado: se o auditor tivesse a sua própria cópia da regra de "dinheiro
válido", as duas poderiam divergir e a auditoria aprovaria dados que o backend
endurecido depois recusaria — exatamente a falha que esta ferramenta existe para
evitar.

Problemas detectados: `missing`, `not-a-number`, `nan`, `infinite`, `negative`,
`too-many-decimals` (valores sub-centavo reais — **não** o drift de ULP, que é
absorvido com segurança), `unsafe`, `above-limit`.

### Tournaments

Classificação do formato dos pares de participantes:

| Categoria | Bloqueante? | Observação |
|---|---|---|
| `canonical-only` | não | `current_participants` / `max_participants` |
| `legacy-only` | **não** | O backend lê pelo fallback legado. Saudável. |
| `both-matching` | não | Estado ideal |
| `both-diverging` | **sim** | O backend recusa: não dá para adivinhar qual é o certo |
| `partial` | **sim** | Par pela metade — escrita corrompida |
| `capacity-missing` | **sim** | Sem capacidade. Nunca pode ser tratado como 0 |

Problemas de valor: `non-integer` (bloqueante), `negative` (bloqueante) e
`current-exceeds-max` (**relatado, não bloqueante** — o `jointournament` já trata
como "lotado" e recusa a inscrição, que é o desfecho seguro).

`legacy-only` **não** conta como anomalia. Contá-la afogaria os problemas reais em
ruído logo na primeira execução — praticamente todo torneio existente foi criado
pelo `createTournament` antigo, que só escrevia o par legado.

## Arquitetura

Coleta, validação e apresentação são separadas, e o núcleo é puro e testável sem
Firebase:

| Arquivo | Papel | Depende do Firebase? |
|---|---|---|
| `audit/guard.ts` | Decide se pode rodar e contra o quê | **não** |
| `audit/walletAudit.ts` | Valida uma wallet (reusa `money.ts`) | **não** |
| `audit/tournamentAudit.ts` | Classifica um torneio | **não** |
| `audit/report.ts` | Agrega, renderiza, define exit code | **não** |
| `audit/collector.ts` | Leitura paginada via `ReadOnlyQuery` | **não** |
| `audit/cli.ts` | Entrypoint; importa o SDK só após aprovação | sim |

A leitura é paginada (200 documentos por página, cursor pelo id do documento), de
modo que uma coleção grande nunca é carregada inteira na memória.
