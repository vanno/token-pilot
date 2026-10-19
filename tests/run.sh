#!/bin/sh
# token-pilot — tests des scripts (hooks, barre d'état, bilan, audit).
# Usage : sh tests/run.sh   (lance les cas avec jq, puis sans jq si jq est installé)
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
bin="$root/bin"
fails=0
ok() { printf '  ok   %s\n' "$1"; }
ko() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
has() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }

run_cases() {
  label=$1
  echo "== $label"
  HOME=$(mktemp -d); export HOME

  out=$(printf '%s' '{"session_id":"s1","prompt":"ok","cwd":"/a","hook_event_name":"UserPromptSubmit"}' | "$bin/tp-route-hint")
  [ -z "$out" ] && ok "route-hint : silence sur un message court" || ko "route-hint : message court"

  out=$(printf '%s' '{"session_id":"s1","prompt":"corrige le bouton \"Valider\" de la page","cwd":"/projets/fable-app"}' | "$bin/tp-route-hint")
  has "$out" "[token-pilot] Route" && ok "route-hint : rappel sur une vraie demande" || ko "route-hint : rappel absent"
  has "$out" "jamais de ta propre initiative" && ok "route-hint : « fable » hors du prompt ignoré" || ko "route-hint : « fable » lu hors du prompt"

  out=$(printf '%s' '{"session_id":"s1","prompt":"utilise fable pour ce bug tenace"}' | "$bin/tp-route-hint")
  has "$out" "mentionne Fable" && ok "route-hint : demande explicite de Fable" || ko "route-hint : Fable non détecté"

  out=$(printf '%s' '{"session_id":"s1","prompt":"une longue demande normale"}' | TOKEN_PILOT_QUIET=1 "$bin/tp-route-hint")
  [ -z "$out" ] && ok "route-hint : TOKEN_PILOT_QUIET" || ko "route-hint : TOKEN_PILOT_QUIET"

  out=$(printf '%s' '{"session_id":"s1","source":"startup","model":"claude-opus-5-5"}' | "$bin/tp-session-start")
  has "$out" "/model sonnet" && ok "session-start : alerte Opus" || ko "session-start : alerte Opus"

  out=$(printf '%s' '{"session_id":"s1","source":"startup","model":"claude-sonnet-5-5"}' | "$bin/tp-session-start")
  has "$out" "/model sonnet" && ko "session-start : alerte à tort sur Sonnet" || ok "session-start : rien sur Sonnet"

  printf '%s' '{"session_id":"s1","agent_type":"eclaireur"}' | "$bin/tp-agent-log"
  has "$(cat "$HOME/.claude/token-pilot/agents.tsv" 2>/dev/null)" "eclaireur	s1" && ok "agent-log : journalisé" || ko "agent-log : journal"

  rm -rf "$HOME"
}

run_cases "avec jq"

# Sans jq : PATH réduit à un dossier de liens vers les outils de base
if command -v jq >/dev/null 2>&1; then
  nojq=$(mktemp -d)
  for t in sh cat sed tr head wc date mkdir printf rm mktemp dirname; do
    p=$(command -v "$t" 2>/dev/null) && case "$p" in /*) ln -s "$p" "$nojq/$t" ;; esac
  done
  OLDPATH=$PATH; PATH=$nojq
  run_cases "sans jq"
  PATH=$OLDPATH; rm -rf "$nojq"
fi

echo "== barre d'état, bilan, audit"
HOME=$(mktemp -d); export HOME
out=$(printf '%s' '{"session_id":"s2","model":{"id":"claude-sonnet-5-5","display_name":"Sonnet 5.5"},"context_window":{"used_percentage":34},"rate_limits":{"five_hour":{"used_percentage":22},"seven_day":{"used_percentage":41}},"cost":{"total_cost_usd":1.2},"workspace":{"project_dir":"/p/demo"}}' | "$bin/tp-statusline")
has "$out" "Sonnet 5.5" && has "$out" "7j" && ok "statusline : rendu" || ko "statusline : rendu ($out)"
[ -s "$HOME/.claude/token-pilot/sessions/s2.json" ] && ok "statusline : instantané écrit" || ko "statusline : instantané"
out=$(python3 "$bin/tp-bilan" 7)
has "$out" "Sessions : 1" && ok "bilan : lit l'instantané" || ko "bilan ($out)"
python3 "$bin/tp-audit" "$root" >/dev/null && ok "audit : s'exécute" || ko "audit"
rm -rf "$HOME"

echo
[ "$fails" -eq 0 ] && echo "Tous les tests passent." || echo "$fails échec(s)."
exit "$fails"
