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

# jq.exe natif sous Git Bash : mêmes cas avec un jq qui répond en CRLF
if command -v jq >/dev/null 2>&1; then
  crlf=$(mktemp -d)
  realjq=$(command -v jq)
  printf '#!/bin/sh\n"%s" "$@" | sed "s/$/\\r/"\n' "$realjq" > "$crlf/jq"; chmod +x "$crlf/jq"
  OLDPATH=$PATH; PATH="$crlf:$PATH"
  run_cases "jq en CRLF (Windows)"
  HOME=$(mktemp -d); export HOME
  printf '%s' '{"session_id":"s1","agent_type":"eclaireur"}' | "$bin/tp-agent-log"
  has "$(od -c "$HOME/.claude/token-pilot/agents.tsv")" '\r' && ko "agent-log : CR dans le journal" || ok "agent-log : pas de CR"
  out=$(printf '%s' '{"session_id":"s3","model":{"display_name":"Sonnet 5.5"},"context_window":{"used_percentage":71}}' | "$bin/tp-statusline")
  has "$out" "$(printf '\r')" && ko "statusline : CR dans le rendu" || ok "statusline : rendu sans CR"
  [ -s "$HOME/.claude/token-pilot/sessions/s3.json" ] && ok "statusline : instantané au bon nom" || ko "statusline : nom d'instantané ($(ls "$HOME/.claude/token-pilot/sessions"))"
  rm -rf "$HOME"
  PATH=$OLDPATH; rm -rf "$crlf"
fi

echo "== barre d'état, bilan, audit"
HOME=$(mktemp -d); export HOME
out=$(python3 "$bin/tp-bilan" 7)
has "$out" "Aucune donnée" && ok "bilan : sans données" || ko "bilan : sans données ($out)"
out=$(printf '%s' '{"session_id":"s2","model":{"id":"claude-sonnet-5-5","display_name":"Sonnet 5.5"},"context_window":{"used_percentage":34},"rate_limits":{"five_hour":{"used_percentage":22},"seven_day":{"used_percentage":41}},"cost":{"total_cost_usd":1.2},"workspace":{"project_dir":"/p/démo"}}' | "$bin/tp-statusline")
has "$out" "Sonnet 5.5" && has "$out" "7j" && ok "statusline : rendu" || ko "statusline : rendu ($out)"
has "$out" '$1.20' && ok "statusline : coût" || ko "statusline : coût ($out)"
[ -s "$HOME/.claude/token-pilot/sessions/s2.json" ] && ok "statusline : instantané écrit" || ko "statusline : instantané"
printf 'pas du json' > "$HOME/.claude/token-pilot/sessions/abime.json"
out=$(python3 "$bin/tp-bilan" 7)
has "$out" "Sessions : 1" && ok "bilan : lit l'instantané, ignore un fichier abîmé" || ko "bilan ($out)"
has "$out" "démo" && ok "bilan : projet accentué" || ko "bilan : projet accentué"
out=$(PYTHONIOENCODING=cp1252 python3 "$bin/tp-bilan" 7 2>&1) && ok "bilan : console cp1252 (Windows)" || ko "bilan : cp1252 ($out)"
python3 "$bin/tp-audit" "$root" >/dev/null && ok "audit : s'exécute" || ko "audit"
PYTHONIOENCODING=cp1252 python3 "$bin/tp-audit" "$root" >/dev/null 2>&1 && ok "audit : console cp1252 (Windows)" || ko "audit : cp1252"
nojq=$(mktemp -d); ln -s "$(command -v cat)" "$nojq/cat"
out=$(printf '%s' '{"model":{"display_name":"Sonnet"}}' | PATH=$nojq /bin/sh "$bin/tp-statusline")
rm -rf "$nojq"
has "$out" "installe jq" && ok "statusline : message sans jq" || ko "statusline : sans jq ($out)"
rm -rf "$HOME"

echo "== manifestes"
for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json hooks/hooks.json; do
  python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$root/$f" && ok "JSON valide : $f" || ko "JSON invalide : $f"
done
for f in "$root"/agents/*.md "$root"/skills/*/SKILL.md; do
  [ "$(head -n 1 "$f")" = "---" ] && grep -q '^name:' "$f" && grep -q '^description:' "$f" && ok "frontmatter : ${f#$root/}" || ko "frontmatter : ${f#$root/}"
done
for f in "$root"/bin/*; do
  [ -x "$f" ] && ok "exécutable : ${f#$root/}" || ko "non exécutable : ${f#$root/}"
done

echo
[ "$fails" -eq 0 ] && echo "Tous les tests passent." || echo "$fails échec(s)."
exit "$fails"
