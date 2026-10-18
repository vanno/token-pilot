---
name: token-pilot-setup
description: Configuration initiale de token-pilot sur ce poste — Sonnet comme modèle par défaut de la session et barre d'état de consommation. À lancer une fois après l'installation du plugin, ou pour réparer la barre d'état.
disable-model-invocation: true
model: sonnet
---

# Configuration de token-pilot

Un plugin ne peut pas fixer lui-même le modèle par défaut ni la barre d'état principale : il faut les écrire dans `~/.claude/settings.json`. Fais-le ainsi :

1. **Vérifier les prérequis** avec Bash :
   - `command -v jq` — si absent, dis à l'utilisateur : `brew install jq` (macOS) ou `sudo apt install jq`, puis continue (la barre d'état affichera un message en attendant).
   - `command -v python3` — nécessaire pour `/token-audit` et `/bilan-conso`. Si absent, signale-le.
   - `command -v tp-statusline` — chemin du script fourni par le plugin.

2. **Copier le script** de barre d'état à un emplacement stable (le chemin du plugin change à chaque mise à jour) :
   ```sh
   mkdir -p ~/.claude/token-pilot && cp "$(command -v tp-statusline)" ~/.claude/token-pilot/statusline.sh && chmod +x ~/.claude/token-pilot/statusline.sh
   ```

3. **Lire `~/.claude/settings.json`** (il peut ne pas exister). Montre à l'utilisateur ce qui va changer, puis fusionne sans rien supprimer d'autre :
   - `"model": "sonnet"`
   - `"statusLine": { "type": "command", "command": "~/.claude/token-pilot/statusline.sh", "padding": 0 }`
   Si un `statusLine` existe déjà et ne vient pas de token-pilot, demande avant de le remplacer.
   Écris le fichier avec un JSON valide (vérifie avec `jq . ~/.claude/settings.json`).

4. **Vérifier les variables d'environnement** qui écraseraient le routage : si `ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` ou `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` sont définies (`env | grep -E 'ANTHROPIC_MODEL|SUBAGENT_MODEL'`), explique laquelle bloque quoi et propose de la retirer du profil shell.

5. **Conclure** en 3 lignes : ce qui a été configuré, `/model sonnet` pour la session en cours, et que les nouvelles sessions démarreront sur Sonnet avec la barre `modèle · effort · ctx % · 5h % · 7j % · coût`.

Réponds en français.
