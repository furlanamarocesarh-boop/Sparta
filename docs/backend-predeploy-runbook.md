# Runbook de pré-deploy do backend endurecido

Preparado por um **preflight somente leitura**. Nenhum deploy, escrita em
produção, callable, custom claim, push ou merge foi executado ao produzi-lo.

Sem tokens, e-mails, UIDs, PII ou credenciais. Sem comandos destrutivos. Todo
comando de deploy abaixo é **por função** (`--only functions:NOME`); **nunca**
há um `firebase deploy` amplo.

---

## 1. Estado atual e hashes

| Item | Valor |
|---|---|
| Branch do preflight | `chore/backend-predeploy` (a partir de `master`) |
| master HEAD | `0b06e25` (merge: integrate hardened backend foundation) |
| Baseline implantado (Cloud Functions) | `b70c159` |
| Baseline das regras publicadas | `86f7ec3` |
| Projeto (`.firebaserc`) | `sparta-battle` |
| Runtime declarado | Node 20 (`functions/package.json` → `engines.node`) |
| Região das callables (produção) | `us-central1` |
| Região do `onUserCreated` (produção) | **`us-east1`** (ver Bloqueador B) |

### Ambiente local

| Ferramenta | Versão |
|---|---|
| Node | v24.15.0 (⚠ deploy roda em Node 20 — divergência benigna, ver §5) |
| npm | 11.12.1 |
| Firebase CLI | 15.17.0 |
| Java (Temurin) | 21.0.11 (necessário só para o emulador de regras) |
| gcloud | não instalado (não exigido para deploy de funções/regras) |

---

## 2. Inventário local versus produção

**Produção tem 10 funções; o código local exporta 7.** Todas em Gen 1 (`v1`),
runtime `nodejs20`, memória 256 MB, trigger `callable` (exceto `onUserCreated`).

| Função (produção) | Região | No código local? | Observação |
|---|---|---|---|
| `createTournament` | us-central1 | ✅ sim | alterada |
| `createtournament` | us-central1 | ✅ sim | alterada (alias) |
| `jointournament` | us-central1 | ✅ sim | alterada |
| `payprize` | us-central1 | ✅ sim | alterada |
| `requestwithdrawal` | us-central1 | ✅ sim | alterada |
| `testdeposit` | us-central1 | ✅ sim | alterada |
| `onUserCreated` | **us-east1** | ✅ sim (mas região diverge) | **inalterada** |
| `joinTournament` | us-central1 | ❌ **NÃO** | fantasma camelCase |
| `payPrize` | us-central1 | ❌ **NÃO** | fantasma camelCase |
| `requestWithdrawal` | us-central1 | ❌ **NÃO** | fantasma camelCase |

Nenhuma função local está ausente de produção. **Três funções de produção estão
ausentes localmente** (fantasmas camelCase). Ver Bloqueador A.

---

## 3. Resultado dos testes (preflight, em `chore/backend-predeploy`)

| Comando | Resultado |
|---|---|
| `npm ci` | exit 0 |
| `npm run build` | exit 0, zero erros TS |
| `npm test` | **136 aprovados / 0 reprovados** (39 suites) |
| `npm run test:rules` | **24 aprovados / 0 reprovados** (10 suites) |
| `git diff --check` | limpo |
| Auditoria estrutural read-only (produção) | **exit 0** — 5 wallets sem problemas, 3 tournaments `both-matching` |

---

## 4. Auditoria de dependências (resumo — não corrigida)

Executado `npm audit`, `npm audit --omit=dev` e `npm outdated`. **Nada foi
corrigido nem atualizado.**

- **Runtime (produção):** 13 vulnerabilidades → 3 **high**, 10 moderate, 0 critical.
- **Somente dev/teste:** 4 adicionais (1 low, 3 moderate) — `@babel/core`,
  `firebase-functions-test`, `js-yaml`, `ts-deepmerge`. **Não** vão para produção
  (`test/` e devDependencies são ignorados no pacote de deploy). Não bloqueiam.

### As 3 high de runtime (todas transitivas via `firebase-admin`)

| Pacote | Advisory | Alcançável? | Fix |
|---|---|---|---|
| `@grpc/grpc-js` | GHSA-5375-pq7m-f5r2 — crash do servidor com request malformado | Baixa: as funções são **clientes** gRPC do Firestore, não servidores | disponível, **não-breaking** |
| `form-data` | GHSA-hmw2-7cc7-3qxx — CRLF injection via nomes de campo multipart | Baixa: as funções não montam multipart com nomes controlados por atacante | disponível, **não-breaking** |
| `protobufjs` | GHSA-jggg-4jg4-v7c6 — DoS via expansão recursiva de descritor JSON | Baixa: não há parse de descritores proto não confiáveis | disponível, **não-breaking** |

As três têm correção **não-breaking**, provavelmente resolvida por um bump
transitivo. **Não** aplicar aqui (proibido nesta etapa). Recomendação: resolver
numa etapa separada de manutenção de dependências, com `npm audit` revisto e a
suíte de testes reexecutada.

O caminho "corretivo" mais amplo aponta para `firebase-admin@14.1.0`, que é
**major/breaking** — **não** fazer sem plano de teste dedicado.

---

## 5. Bloqueadores

### 🔴 Bloqueador A — funções fantasmas em produção (camelCase)

`joinTournament`, `payPrize`, `requestWithdrawal` existem em produção mas **não**
no código local. Um `firebase deploy --only functions` **amplo tentaria excluí-las**.

- **Mitigação obrigatória:** deploy **sempre por função** (`--only functions:NOME`).
  Nunca amplo. Esta é a razão pela qual todo comando neste runbook é individual.
- **Ação separada (fora deste deploy):** investigar se algum cliente
  (FlutterFlow/legado) ainda chama as versões camelCase. Se **não**, removê-las
  deliberadamente numa etapa própria e autorizada. Se **sim**, migrar os clientes
  antes de qualquer remoção.

### 🔴 Bloqueador B — divergência de região do `onUserCreated`

Produção: `us-east1`. Código local (`auth.user().onCreate` sem `.region()`):
default **us-central1**.

- `onUserCreated` está **inalterado** entre `b70c159` e `master`, então **não há
  motivo para deployá-lo** — e ele fica **fora** deste deploy.
- **NÃO** deployar `onUserCreated` a partir do código atual: criaria uma cópia em
  us-central1 e deixaria a de us-east1 órfã (dois triggers de criação de usuário).
- Se um dia precisar mudar `onUserCreated`, **primeiro** fixar `.region('us-east1')`
  no código, e tratar como migração à parte.

### 🟠 Bloqueador C — 3 vulnerabilidades high em runtime

Pela política ("high/critical alcançável em runtime → deploy bloqueado até
revisão"), as 3 acima **exigem revisão de segurança** antes do deploy. A análise
de alcançabilidade acima sugere risco prático baixo, mas a decisão de dispensa
("waiver") é de um revisor de segurança, não deste runbook.

### Divergência benigna (não bloqueia)

Node local v24 vs runtime de deploy Node 20. O pacote deployado roda em Node 20
(`engines.node`); os testes locais em Node 24. Vale rodar um smoke em ambiente
Node 20 se possível, mas não é bloqueador.

---

## 6. Ordem de deploy recomendada (derivada do diff real)

Somente as **6 funções alteradas** são deployadas. `onUserCreated` é pulado
(inalterado + Bloqueador B). A ordem permite que cada smoke test use os dados de
teste criados pelo passo anterior.

1. **`testdeposit`** — admin-only; credita saldo de teste (habilita os smokes seguintes).
2. **`createTournament`** e **`createtournament`** — corrigem o bug dos campos de
   participante (passam a escrever ambos os pares canônicos e iguais).
3. **`jointournament`** — debita entry fee, cria registration (precisa de saldo + torneio).
4. **`requestwithdrawal`** — debita saldo (precisa de saldo).
5. **`payprize`** — credita prêmio ao vencedor (admin-only).

**Pré-condição de todos:** Bloqueadores A, B e C endereçados/revistos. Enquanto A
e C não forem tratados, **não iniciar** o deploy.

---

## 7. Comandos de deploy (executar somente após autorização)

> Todos por função. Nenhum `firebase deploy` amplo. Rodar de `D:\Projects\spartagg`.

### Etapa 1 — testdeposit
```
firebase deploy --only functions:testdeposit --project sparta-battle
```
Smoke (contas e dinheiro **exclusivamente de teste**): chamar `testdeposit` com a
conta admin de teste, valor pequeno; conferir no app/console que o `balance` da
wallet de teste subiu pelo valor exato. Depois:
```
cd functions && node lib/audit/cli.js --project sparta-battle --confirm-read-only-production-audit
```
Deve retornar **exit 0**. Se não, **PARE** (ver §11).

### Etapa 2 — createTournament e createtournament
```
firebase deploy --only functions:createTournament --project sparta-battle
firebase deploy --only functions:createtournament --project sparta-battle
```
Smoke: criar um torneio de teste; conferir que o documento tem
`current_participants=0`, `max_participants=max_players`, e ambos os pares iguais.

### Etapa 3 — jointournament
```
firebase deploy --only functions:jointournament --project sparta-battle
```
Smoke: com uma wallet de teste financiada (Etapa 1) e o torneio de teste (Etapa 2),
entrar no torneio; conferir débito exato do entry fee, criação de `registration` e
de uma `transaction` `entry_fee`/`completed`. Auditoria read-only → exit 0.

### Etapa 4 — requestwithdrawal
```
firebase deploy --only functions:requestwithdrawal --project sparta-battle
```
Smoke: com wallet de teste financiada, solicitar saque válido (≥ R$5, ≤ R$10.000);
conferir débito exato, `withdrawal` `pending` e `transaction` `withdrawal`.
Auditoria read-only → exit 0.

### Etapa 5 — payprize
```
firebase deploy --only functions:payprize --project sparta-battle
```
Smoke: com a conta admin de teste, pagar prêmio a uma wallet de teste vencedora;
conferir crédito exato e `transaction` `prize`/`completed`. Auditoria read-only → exit 0.

---

## 8. Smoke test — regras

- Sempre com **contas e dinheiro exclusivamente de teste**.
- Após **cada** etapa financeira (3, 4, 5), rodar a **auditoria estrutural
  read-only** e exigir **exit 0** antes de prosseguir.
- Confirmar valores exatos (centavos), nunca aproximados.
- Nunca chamar funções de produção com dados reais (não existem dados reais hoje;
  manter assim até o beta).

---

## 9. Critério de parada entre funções

**PARE e não avance** se, após uma etapa:

- a auditoria read-only não retornar exit 0;
- um saldo/total divergir do valor exato esperado;
- surgir qualquer `transaction`/`withdrawal`/`registration` inesperada;
- a função deployada retornar erro diferente das mensagens pt-BR conhecidas;
- `firebase functions:list` mostrar remoção acidental de qualquer função (inclusive
  os fantasmas camelCase, que **não** devem ser removidos por deploy).

---

## 10. Rollback por função

Cada função é isolada; o rollback é por função, **nunca** amplo.

- **Rollback de código:** reverter a função no código para o estado `b70c159` e
  redeployar **somente aquela função** com `--only functions:NOME`. Como o
  contrato externo (nomes, args, collections, campos, categorias) é **idêntico**
  ao baseline, um rollback de uma função não afeta as demais.
- **Sem migração de dados:** o endurecimento não muda o schema externo (reais em
  Firestore), então reverter uma função não exige tocar dados.
- **Ordem de rollback:** inverter a ordem de deploy (5 → 1) se precisar reverter
  várias, revalidando a auditoria a cada passo.

---

## 11. Regras do Firestore — etapa SEPARADA

Publicar as regras é **independente** do deploy de funções e só deve ocorrer após
o deploy das funções estar estável.

- **Único diff funcional** (`86f7ec3` → `master`): `isAdmin()` passa a aceitar
  `hasAdminClaim() || isLegacyAdmin()`. É **aditivo e compatível** — o UID legado
  continua funcionando; nenhum acesso existente é revogado.
- **Seletor da CLI:** a CLI 15.17.0 suporta `--only <targets>`. O `firebase.json`
  declara em `firestore` **apenas** `rules` (sem `indexes`), então o seletor exato
  e mínimo é `firestore:rules` — publica só as regras, não índices.

```
firebase deploy --only firestore:rules --project sparta-battle
```

- ⚠ **Publicar substitui as regras do Console.** As regras publicadas por este
  comando sobrescrevem o que estiver no Console do Firebase. Como o master
  preserva byte-a-byte as regras implantadas (`86f7ec3`) e só adiciona o caminho
  do custom claim, isso é seguro — mas confirme que ninguém editou as regras no
  Console desde então (comparar com `firestore.rules` antes de publicar).
- Smoke das regras: os 24 testes de regras já cobrem signed-out negado, leitura
  do próprio dado, escrita financeira bloqueada, admin por claim **e** por UID
  legado, e collections desconhecidas negadas.

---

## 12. Transição administrativa em duas fases (NÃO executar agora)

Detalhe completo em `docs/admin-transition.md`. Resumo:

- **Fase 1:** atribuir o custom claim `admin: true` ao administrador (operação
  local única, com Admin SDK — **não** há callable que conceda admin). Depois,
  **atualizar o token** (o claim é embutido no ID token; token não atualizado não
  tem o claim). Nada quebra: o admin passa a ser autorizado por **ambos** os
  caminhos.
- **Manter o UID legado** aceito enquanto o claim/token não forem comprovados em
  produção (idealmente testando com um **segundo** admin por claim).
- **Fase 2 (futura):** só após comprovado, remover o fallback do UID legado em
  `functions/src/domain/adminAuth.ts` **e** em `firestore.rules`, na mesma
  mudança, e deployar funções + publicar regras juntas.

**Nenhum custom claim é atribuído por este runbook nem por esta etapa.**

---

## Apêndice — o que NÃO fazer

- ❌ `firebase deploy` (amplo) — excluiria os fantasmas camelCase.
- ❌ `firebase deploy --only functions` (todas) — mesmo risco.
- ❌ deployar `onUserCreated` a partir do código atual (região divergente).
- ❌ `npm audit fix` / `npm update` / bump de `firebase-admin` sem plano de teste.
- ❌ atribuir custom claim nesta etapa.
- ❌ publicar regras antes de estabilizar as funções.

---

## 13. Investigação das funções legadas camelCase (read-only)

Investigação **estritamente read-only** das três funções que existem apenas em
produção. **Nenhuma foi deletada, atualizada, implantada ou invocada.**

### 13.1 Tabela das três funções legadas

| Legada (produção) | Substituta (código local) | Geração | Região | Runtime | Trigger | Memória |
|---|---|---|---|---|---|---|
| `joinTournament` | `jointournament` | Gen 1 (v1) | us-central1 | nodejs20 | callable | 256 MB |
| `payPrize` | `payprize` | Gen 1 (v1) | us-central1 | nodejs20 | callable | 256 MB |
| `requestWithdrawal` | `requestwithdrawal` | Gen 1 (v1) | us-central1 | nodejs20 | callable | 256 MB |

Metadados adicionais (entry point, service account, nomes de variáveis de
ambiente, timeout, datas de criação/atualização, source archive) **não puderam
ser obtidos** — ver "Bloqueio de evidências".

### 13.2 Referências locais encontradas (busca case-sensitive nos dois repos)

| Origem | camelCase (`joinTournament`/`payPrize`/`requestWithdrawal`) | lowercase (substitutas) |
|---|---|---|
| Backend `functions/src/**` | **nenhuma** (só as lowercase são exportadas) | exports `jointournament`, `payprize`, `requestwithdrawal` |
| Backend docs | só neste runbook | `backend_contract.md` (documentação) |
| App Flutter `lib/**` | **nenhuma chamada** — `AppStrings.joinTournament` é um **rótulo de UI** ("Participar do torneio"), não uma função | nenhuma |
| App Flutter — invocações de callable | **zero** (`httpsCallable`/`cloud_functions`/`FirebaseFunctions`/`.call(` ausentes) | zero |

**Nenhum cliente local — backend ou Flutter — chama as versões camelCase (nem as
lowercase).** O app Flutter atual (fase de autenticação) não invoca nenhuma
Cloud Function.

Achado adicional: as três funções camelCase **nunca existiram no histórico do Git
deste repositório**. Foram implantadas a partir de um source que jamais foi
versionado aqui — sua fonte de verdade é desconhecida/perdida.

### 13.3 Resumo do código implantado

**Não recuperado.** A recuperação do source implantado depende de
`gcloud functions describe` (para obter o source archive) e do IAM apropriado —
e o `gcloud` **não está instalado**. O `firebase` CLI não expõe `functions:describe`.
Como as camelCase também não estão no Git, **não há cópia local** para inspecionar.

Consequência: a comparação de segurança par a par (auth obrigatória, autorização
admin, UID legado, custom claim, transaction, idempotência, inscrição duplicada,
capacidade, `current_players`/`current_participants`, float vs centavos, validação
de valores, collections/campos escritos, caminhos de alteração de saldo, bypasses)
**não pôde ser feita ao nível de código-fonte**. O que segue é análise de **risco
por assinatura**, não verificação de código.

### 13.4 Atividade agregada (30 e 90 dias)

**Não obtida.** Métricas agregadas de invocação exigem Cloud Logging/Monitoring
via `gcloud`, indisponível. O `firebase functions:log` existe, mas (a) esta etapa
proíbe ler mensagens/payloads de log, e (b) ele não produz contagens agregadas
sem risco de PII. **Não foi possível distinguir invocação real de ruído interno**,
nem determinar data da última invocação.

### 13.5 Riscos (análise por assinatura, sem código-fonte)

As três são callables **financeiras** rodando código **não versionado aqui** e que
**provavelmente antecede o endurecimento** (float, UID admin fixo, bug dos campos
de participante). Elas continuam **vivas e chamáveis agora**, e permanecerão vivas
mesmo após o deploy das versões lowercase endurecidas (deploy por função não as
toca). Isso é uma **superfície de bypass do hardening**:

- `requestWithdrawal` — débito chamável por **qualquer usuário autenticado**. Se
  rodar a lógica antiga em float, um cliente poderia sacar pela versão não
  endurecida, contornando a aritmética em centavos. **Maior preocupação.**
- `joinTournament` — débito de entry fee chamável por **qualquer usuário
  autenticado**. Mesmo risco de bypass financeiro.
- `payPrize` — crédito de prêmio **admin-gated** (UID fixo). Exposição limitada a
  quem detém o UID admin, mas ainda é um caminho de escrita financeira não
  endurecido.

### 13.6 Classificação e recomendação por função

| Função | Classificação | Recomendação |
|---|---|---|
| `joinTournament` | **insufficient-evidence** (inclina a *security-critical-retirement*) | Não deixar viva indefinidamente após o deploy endurecido; aposentar após verificação (13.7). |
| `payPrize` | **insufficient-evidence** (inclina a *security-critical-retirement*) | Idem; exposição menor (admin-gated), mas é escrita financeira. |
| `requestWithdrawal` | **insufficient-evidence** (inclina a *security-critical-retirement*) | Prioridade de aposentadoria — débito chamável por usuário. |

**Por que nenhuma é `safe-to-retire`:** a regra exige comprovar "sem atividade
recente relevante", o que a Fase 4 (bloqueada) **não permite verificar**. Sem
source (Fase 3) nem métricas (Fase 4), a evidência é insuficiente para o selo
`safe-to-retire` — apesar de não haver cliente local conhecido.

### 13.7 Pré-condições para futura exclusão (autorização separada obrigatória)

Exclusão **NÃO** é autorizada aqui. Antes de qualquer exclusão futura:

1. Instalar e autenticar o `gcloud` com IAM de **leitura** (sem ampliar permissões).
2. Recuperar e inspecionar o source implantado de cada camelCase (confirmar que
   não têm lógica única e que a lowercase endurecida preserva o contrato).
3. Confirmar **zero invocações nos últimos 90 dias** (Cloud Monitoring).
4. Confirmar que **nenhum cliente** (qualquer app FlutterFlow/web) chama os nomes
   camelCase.
5. Só então excluir **deliberadamente, uma por vez**, por função:
   `gcloud functions delete <NOME> --region us-central1 --project sparta-battle`
   — **nunca** por `firebase deploy` amplo.

### 13.8 Plano de verificação após a exclusão

- `firebase functions:list --project sparta-battle`: a função excluída some, e as
  **7 funções pretendidas permanecem intactas** (casing correto).
- Auditoria estrutural read-only → **exit 0**.
- Smoke test das lowercase endurecidas equivalentes com dados de teste.

### 13.9 Bloqueio de evidências

`gcloud` não instalado ⇒ Fases 3 (source implantado) e 4 (métricas de uso)
**bloqueadas**. Não ampliar IAM, não contornar permissões, não instalar nem
autenticar nada como parte desta etapa read-only. A classificação
`insufficient-evidence` reflete diretamente esse bloqueio.

> **AVISO:** a exclusão de qualquer função exige **autorização explícita e
> separada**. Este documento é uma investigação; não autoriza remoção.

---

## 14. Atualização da investigação — gcloud instalado, conectividade TLS bloqueada

O Google Cloud CLI (575.0.1) está **instalado e autenticado** (há conta ativa com
acesso pretendido ao projeto). Porém, **toda chamada às APIs do Google falha na
camada TLS** antes de chegar ao IAM.

### 14.1 Bloqueio observado (sanitizado)

Erro consistente: **falha de verificação de certificado TLS** (o CA bundle do
gcloud não valida a conexão — sintoma clássico de proxy/firewall corporativo com
inspeção TLS). Confirmado em **três** endpoints independentes:

| Comando (read-only) | Endpoint | Resultado |
|---|---|---|
| `gcloud projects describe` | cloudresourcemanager | falha de certificado TLS |
| `gcloud functions describe` | cloudfunctions | falha de certificado TLS |
| `gcloud logging read` | cloudlogging | falha de certificado TLS |

Não é `PERMISSION_DENIED` nem problema de flag — é transporte (TLS). O e-mail da
conta, tokens e qualquer valor sensível **não foram impressos**.

### 14.2 O que NÃO foi feito (por segurança)

Deliberadamente **não** foi feito, pois seria contornar controles de segurança ou
ampliar superfície de confiança sem autorização:

- **não** desabilitar verificação de certificado (`REQUESTS_CA_BUNDLE`,
  `SSL_CERT_FILE`, `--no-verify` ou equivalente);
- **não** apontar `core/custom_ca_certs_file` para um CA arbitrário (o CA
  corporativo legítimo não está disponível para este processo);
- **não** reinstalar/reconfigurar o gcloud;
- **não** alterar IAM nem ampliar permissões.

### 14.3 Efeito nas fases bloqueadas

| Fase | Status | Causa |
|---|---|---|
| 1 — metadados completos (`functions describe`) | **bloqueada** | falha TLS |
| 2 — source implantado (download do archive) | **bloqueada** | falha TLS |
| 3 — atividade agregada (Cloud Logging 30/90 dias) | **bloqueada** | falha TLS |

Nenhum source foi recuperado; nenhuma contagem de invocação (30/90 dias) pôde ser
apurada; nenhuma última-data-de-execução foi determinada. Sem `execution_id`
acessível, **não** foram inventadas contagens.

### 14.4 Pré-condição para desbloquear (fora desta etapa)

Configurar uma **cadeia de confiança TLS válida para este ambiente** — tipicamente
apontar o gcloud ao **CA raiz corporativo legítimo** via
`gcloud config set core/custom_ca_certs_file <caminho-do-CA-corporativo>` (com o CA
fornecido pela TI), **ou** executar a investigação de uma rede sem proxy de
inspeção TLS. Isso exige o CA correto e autorização — não é uma decisão a tomar
por conta própria contra APIs de produção financeira.

---

## 15. Veredito definitivo desta etapa

Com metadados completos, source e métricas **todos bloqueados** (agora por TLS, não
por ausência de ferramenta), a evidência continua **insuficiente** para o selo
`safe-to-retire` das três funções.

| Função | Classificação (definitiva nesta etapa) | Observação |
|---|---|---|
| `joinTournament` | **insufficient-evidence** | débito chamável por usuário; risco de bypass não verificável |
| `payPrize` | **insufficient-evidence** | crédito admin-gated; escrita financeira não verificável |
| `requestWithdrawal` | **insufficient-evidence** | débito chamável por usuário; prioridade de aposentadoria |

O que **já está estabelecido** (Fase 1 anterior, sem rede): **zero referências**
no backend e no app Flutter atual; nenhum cliente local as invoca; nenhum usuário
ou dinheiro real; todo dado atual é de teste; as substitutas lowercase endurecidas
existem e preservam o contrato. O que **falta** para fechar o veredito: código
implantado (Fase 2) e atividade agregada (Fase 3) — ambos bloqueados por TLS.

### Recomendação

Não deixar as camelCase vivas indefinidamente após o deploy endurecido; porém
**não excluir** sem antes: (a) restaurar conectividade TLS e recuperar o source
implantado + as métricas de 90 dias; ou (b) uma decisão explícita e autorizada de
aposentar mesmo sem esses dados, aceitando o risco — justificável porque não há
cliente local, nem usuários/dinheiro reais, e as substitutas endurecidas existem.
A exclusão continua exigindo **autorização separada**.

---

## 16. Ordem futura segura (aposentadoria das camelCase)

1. **Resolver as dependências high** de runtime (grpc-js, form-data, protobufjs) —
   fix não-breaking, com `npm audit` revisto e suíte reexecutada (etapa própria).
2. **Fixar as regiões no código** — em especial `onUserCreated` (`.region('us-east1')`)
   antes de qualquer deploy dele; confirmar us-central1 para as callables.
3. **Implantar as substitutas lowercase** endurecidas, **por função**
   (`--only functions:NOME`), na ordem do §6.
4. **Executar os smoke tests** (dados de teste) e a **auditoria read-only** após
   cada etapa financeira, exigindo exit 0.
5. **Excluir as camelCase somente com autorização separada**, uma por vez, por
   função (`gcloud functions delete <NOME> --region us-central1 --project
   sparta-battle`) — **nunca** por `firebase deploy` amplo. Pré-condições em §13.7.
6. **Verificar** `firebase functions:list` (as 7 pretendidas intactas, casing
   correto; camelCase ausentes) e a **auditoria estrutural read-only** (exit 0).

### Rollback (reforço)

- Por função: reverter o código ao estado `b70c159` e redeployar **só** aquela
  função. Contrato externo idêntico ⇒ sem migração de dados, sem efeito nas demais.
- A exclusão de uma camelCase **não** tem rollback trivial (recriar exigiria o
  source perdido) — por isso ela vem **por último** e só após verificação completa.

### Proibição (reforço)

- ❌ **Nunca** `firebase deploy` amplo nem `--only functions` (todas): excluiria as
  camelCase de forma não controlada. Todo deploy é **por função**.

---

## 17. Resolução dos bloqueadores (branch `fix/backend-predeploy-blockers`)

Etapa **local, sem deploy**. Endereça os Bloqueadores B (região) e C (high de
runtime). O Bloqueador A (funções fantasma) permanece — sua remoção exige
autorização separada (§13, §16).

### 17.1 Dependências high de runtime — RESOLVIDAS

Adicionados **overrides** mínimos e não-breaking (mesma major) para os três
pacotes transitivos com advisory high, via `package.json`. **Nenhuma dependência
direta mudou** (`firebase-admin ^13.6.0`, `firebase-functions ^7.0.0`
inalteradas). Sem `npm audit fix --force`, sem major, sem migração Gen 2, sem
mudar Node 20 nem `firebase-functions/v1`.

| Pacote (transitivo) | Antes | Depois | Advisory coberto |
|---|---|---|---|
| `@grpc/grpc-js` (sob `google-gax`, runtime) | 1.14.3 | 1.14.4 | GHSA-5375-pq7m-f5r2 (high) |
| `form-data` (runtime) | 2.5.5 | 2.5.6 | GHSA-hmw2-7cc7-3qxx (high) |
| `protobufjs` (runtime) | 7.5.7 | 7.6.5 | GHSA-wcpc-wj8m-hjx6 (high) + GHSA-jggg-4jg4-v7c6 |

- O override de `@grpc/grpc-js` é **escopado** sob `google-gax` para não tocar o
  `@grpc/grpc-js@1.9.x` de **dev** (rules-testing), que não é vulnerável.
- `protobufjs` foi para **7.6.5** (última 7.x) porque, além do advisory original
  (`<=7.5.7`), a base publicou um segundo high `<=7.6.0`; 7.6.5 cobre ambos sem ir
  para a major 8.

**Resultado:** runtime com **0 critical, 0 high**. Restam **10 moderate de
runtime** (todas transitivas via `firebase-admin`; correção só em
`firebase-admin@14.x`, que é **major/breaking** — deixadas **documentadas, não
mascaradas**, para uma etapa própria de upgrade com plano de teste). Vulns
somente-dev (fora do pacote de deploy): não bloqueiam.

### 17.2 Regiões explícitas — FIXADAS

O `src/index.ts` agora declara a região de **cada** export, via `region(...)` do
`firebase-functions/v1`, centralizada em duas constantes:

- `onUserCreated` → **us-east1** (igual à produção);
- as seis callables → **us-central1** (igual à produção).

Mudou **apenas a região** — nome, casing, argumentos, trigger, memória, timeout,
runtime e geração intactos; nenhum export novo; nenhum alias camelCase. Testes
comprovam a região produzida por cada export (via `__trigger.regions`).

**Confirmação (Bloqueador B):** com `onUserCreated` fixado em us-east1, um futuro
`firebase deploy --only functions:onUserCreated --project sparta-battle`
**atualiza a função existente em us-east1**, sem criar cópia em us-central1.

### 17.3 Funções legadas camelCase — decisão registrada

Classificação de precaução: **security-critical-retirement** para
`joinTournament`, `payPrize`, `requestWithdrawal`, mesmo sem source e sem
métricas (bloqueio TLS de observabilidade — §14), porque são operações
financeiras, seu código não está versionado, não há referência no backend nem no
app Flutter atual, não há usuários/dinheiro reais, e as substitutas lowercase
endurecidas existem.

- **Nenhuma exclusão aconteceu nesta etapa.**
- As **lowercase endurecidas serão implantadas e testadas primeiro** (§6, §16).
- A exclusão de **cada** camelCase exige **autorização separada** (§13.7, §16.5).
- O **bloqueio TLS** (§14) limita a **observabilidade** (metadata/source/logs via
  gcloud), **não** o deploy seletivo por função via **Firebase CLI**, que
  independe daquele canal TLS. Ou seja: o deploy das lowercase pode prosseguir sob
  autorização mesmo com o gcloud bloqueado.
- ❌ Nunca recomendar deploy amplo.
