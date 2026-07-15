# Histórico de manutenção de dados de teste

Registro das operações de manutenção realizadas no projeto `sparta-battle`
**antes do beta**, enquanto todos os dados eram exclusivamente de teste.

Documento agregado e anonimizado por design: **não contém** IDs de documento,
UIDs, e-mails, chaves PIX, WhatsApp, valores secretos, PII, comandos de aplicação
reutilizáveis nem fingerprints. As ferramentas que executaram estas operações
foram **aposentadas** após o uso (ver "Aposentadoria", abaixo).

## Contexto

O proprietário confirmou explicitamente, antes de qualquer escrita, que:

- todos os usuários e valores existentes eram de **teste**;
- **não havia dinheiro real nem usuários reais**;
- todo o ledger de teste (transactions, withdrawals, registrations) podia ser
  descartado;
- os usuários/Auth e os torneios deveriam ser **preservados**.

Cada operação de escrita foi autorizada individualmente e precedida de um
dry-run read-only.

## Operações realizadas

### 1. Limpeza inicial — 3 documentos

Removeu duas anomalias pontuais encontradas pela reconciliação read-only:

- uma wallet de teste com transaction falsa: campos financeiros zerados,
  `user_ref` corrigido, e a única transaction falsa removida — o usuário e a
  autenticação foram **preservados**;
- uma wallet órfã (sem usuário correspondente) removida.

Total: **3 escritas** (1 update de wallet, 2 deletes), numa transaction atômica.

### 2. Reset financeiro atômico — 32 writes

Deixou uma base financeira limpa:

- **5 wallets** com os cinco campos monetários zerados e `user_ref` correto;
- **transactions, withdrawals e registrations** esvaziadas;
- **3 tournaments** normalizados: ambos os pares de participantes
  (canônico e legado) zerados e iguais, com a capacidade preservada;
- **users e Firebase Auth intocados**; nenhum campo não financeiro alterado.

Total: **32 escritas**, numa única transaction atômica. Nenhuma escrita parcial.

### 3. Exclusão de conta Auth órfã — 1 exclusão

Após o reset, restava **1 conta do Firebase Auth sem `users/{uid}` e sem
`wallets/{uid}`** e sem qualquer referência financeira. Foi removida com uma
única operação `auth.deleteUser`. **Nenhum documento do Firestore** foi criado,
alterado ou removido nesta etapa.

## Verificações posteriores

Após cada operação, o estado foi reconferido de forma **independente** (auditoria
read-only e leitura agregada direta), nunca apenas pela mensagem de sucesso da
ferramenta. Cada ferramenta destrutiva também foi reexecutada em dry-run para
confirmar **idempotência** (zero operações planejadas na segunda passagem).

## Estado final agregado

| Recurso | Estado |
|---|---|
| Contas Firebase Auth | 5 |
| `users/{uid}` | 5 |
| `wallets/{uid}` | 5 (todas zeradas, `user_ref` correto) |
| Correspondência Auth ↔ users ↔ wallets | 1-para-1, sem órfãos |
| `tournaments` | 3 (pares de participantes canônicos e iguais) |
| `transactions` / `withdrawals` / `registrations` | 0 / 0 / 0 |
| Auditoria estrutural read-only | exit 0 (nenhuma anomalia) |

## Commits relacionados

Toda a implementação das ferramentas e as etapas acima permanecem rastreáveis no
histórico do Git:

| Commit | Descrição |
|---|---|
| `e446b1a` | Endurecimento do backend (money em centavos, participantes, admin) |
| `ef2d774` | Auditoria de dados read-only |
| `82c6015` | Reconciliação de wallets read-only |
| `efe8675` | Ferramenta de limpeza pontual (operação 1) |
| `e4de1b1` | Ferramenta de reset financeiro (operação 2) |
| `b076818` | Ferramenta de exclusão de Auth órfão (operação 3) |

## Aposentadoria das ferramentas

As três ferramentas **destrutivas de uso único** (limpeza pontual, reset
financeiro e exclusão de Auth órfão) cumpriram seu propósito e foram
**retiradas do código ativo** após o uso. Elas continuam acessíveis apenas pelo
histórico do Git (commits acima), não no source de `master`.

As ferramentas **read-only** — auditoria estrutural e reconciliação — foram
**preservadas** em `functions/src/audit/`, pois são úteis de forma recorrente e
não realizam escrita.
