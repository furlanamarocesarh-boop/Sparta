#!/usr/bin/env bash
#
# Deploy do caixa da plataforma.
#
# UMA FUNÇÃO POR VEZ, projeto nomeado. Nunca amplo — regra do
# docs/backend-predeploy-runbook.md §7.
#
# A ORDEM VEM DE UMA VERIFICAÇÃO, NÃO DE PREFERÊNCIA.
#
# Leitura somente-leitura da produção em 2026-08-24: 7 torneios, TODOS `open`.
# Nenhum em andamento, então este deploy não prende nenhuma liquidação em voo.
# Mas TODOS têm prêmio acima do arrecadado — o que significa que, assim que a
# trava de solvência subir, nenhum deles poderá ser liquidado enquanto o caixa
# estiver vazio.
#
# Por isso `fundHouse` vai PRIMEIRO: em nenhum instante existe a cobrança sem
# existir o meio de aportar. Se o deploy parar no meio, o pior estado é ter a
# capacidade de aportar sem a trava — que é exatamente o estado de hoje.
#
# Pré-requisitos verificados antes desta execução:
#   821/821 unitário · 82/82 e2e · 498/498 regras · tsc limpo
#
# Uso:  bash scripts/deploy-house-treasury.sh
set -euo pipefail

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

# ── O meio de aportar, antes de qualquer cobrança.
deploy functions:fundHouse "aporte no caixa — precisa existir ANTES da trava"

# ── A trava de solvência, nos dois caminhos de liquidação. `payprize` é alias
#    estrito do mesmo handler de declareTournamentResult: deixá-lo para trás
#    abriria um endpoint admin sem a trava.
deploy functions:declareTournamentResult          "trava de solvência"
deploy functions:payprize                         "alias do mesmo handler"
deploy functions:declareTournamentResultWithKills "trava de solvência + pool sem teto"

# ── Regras por último. Sem elas o painel não lê o saldo do caixa.
deploy firestore:rules "house: admin lê, ninguém escreve"

echo "═════════════════════════════════════════════════════════════"
echo "Concluído. Inventário esperado: 25 funções (24 + fundHouse)."
echo "  npx firebase functions:list --project $PROJECT"
echo
echo "DEPOIS DO DEPLOY — LEIA:"
echo "  Os 7 torneios abertos em produção têm prêmio ACIMA do arrecadado."
echo "  Com o caixa vazio, nenhum deles poderá ser liquidado: a declaração"
echo "  vai recusar com 'O caixa da plataforma não cobre esta premiação.'"
echo "  Aporte pelo painel do criador (Meus torneios > Criador > Adicionar"
echo "  fundos) antes de declarar resultado, ou baixe a premiação."
