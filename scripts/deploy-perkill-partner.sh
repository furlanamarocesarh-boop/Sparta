#!/usr/bin/env bash
#
# Deploy das features "premiação por abate" e "parceiros/indicação".
#
# UMA FUNÇÃO POR VEZ, projeto nomeado explicitamente. Nunca amplo — é a regra do
# docs/backend-predeploy-runbook.md §7, e é por isso que `npm run deploy` está
# deliberadamente bloqueado no package.json.
#
# A ORDEM NÃO É ARBITRÁRIA. Cada passo só entra depois do que ele depende:
# nada consegue CRIAR um torneio por abate antes de tudo que o LIQUIDA estar no
# ar. Se parar no meio, o estado é seguro — o que ainda não foi implantado
# simplesmente não é alcançável pelos clientes.
#
# Pré-requisitos já verificados em 2026-08-23:
#   797/797 unitário · 78/78 e2e · 498/498 regras
#   índices já implantados (7 em produção, os 2 novos inclusos)
#
# Uso:  bash scripts/deploy-perkill-partner.sh
set -euo pipefail

# O runtime declarado é Node 22 (functions/package.json engines). O default da
# máquina é v20, que não corresponde ao que roda em produção.
export PATH="$HOME/.local/share/fnm/node-versions/v22.23.2/installation/bin:$PATH"

PROJECT="sparta-battle"

node --version
echo "Projeto: $PROJECT"
echo

deploy() {
  local target="$1" why="$2"
  echo "─────────────────────────────────────────────────────────────"
  echo "▶ $target"
  echo "  $why"
  npx firebase deploy --only "$target" --project "$PROJECT" --non-interactive
  echo "✔ $target"
  echo
}

# ── Ranking e estatísticas primeiro: passam a entender as categorias de abate.
#    Se ficassem para depois, o primeiro pagamento por abate seria ignorado
#    silenciosamente pelo ranking.
deploy functions:onPrizeTransactionCreated "ranking entende kill_prize/beta_kill_prize"
deploy functions:getPlayerEngagementStats  "estatísticas idem"

# ── A liquidação por abate passa a existir, e o caminho antigo passa a recusar
#    os torneios que pertencem a ela.
deploy functions:declareTournamentResultWithKills "liquidação por abate"
deploy functions:declareTournamentResult          "guarda: recusa torneio por abate"
deploy functions:startTournament                  "aceita colocação zero quando abate paga"

# ── SÓ AGORA um torneio por abate pode ser criado.
deploy functions:createTournament "criação lê kill_prize"
deploy functions:createtournament "alias da criação"

# ── Parceiros. O gatilho é inerte enquanto não houver parceiro atribuído,
#    então entra antes com segurança.
deploy functions:onEntryFeeTransactionCreated "acúmulo de comissão"
deploy functions:createPartner                "registro de parceiro"
deploy functions:claimReferral                "atribuição por código"
deploy functions:getPartnerEarnings           "extrato do parceiro"

# ── Regras por último (runbook §11): só depois das funções estáveis.
#    O diff é aditivo — fecha partners/referral_codes em leitura de admin.
deploy firestore:rules "partners e referral_codes"

echo "═════════════════════════════════════════════════════════════"
echo "Concluído. Confira o inventário:"
echo "  npx firebase functions:list --project $PROJECT"
echo "Esperado: 24 funções (19 antes + 5 novas)."
