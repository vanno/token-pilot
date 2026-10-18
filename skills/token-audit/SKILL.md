---
name: token-audit
description: Audite le projet courant pour trouver ce qui consomme des tokens à chaque session (CLAUDE.md trop longs, serveurs MCP inutiles, réglages de modèle, gros fichiers) et propose des corrections concrètes. À utiliser quand l'utilisateur lance /token-audit ou demande pourquoi ses sessions consomment autant.
model: sonnet
effort: medium
---

# Audit de consommation

1. Lance `tp-audit "$(pwd)"` avec Bash (le script est fourni par le plugin). S'il manque python3, fais l'audit à la main : `wc -l` sur les CLAUDE.md, lecture de `.mcp.json` et de `.claude/settings.json`.
2. Complète par `claude plugin details token-pilot 2>/dev/null` si la commande existe, pour connaître le coût fixe des plugins.
3. Analyse et produis un rapport court en français :

   **Coût fixe par session** : total estimé et répartition (CLAUDE.md, MCP).

   **Actions recommandées**, triées par gain, chacune avec le gain estimé et la commande ou le changement exact :
   - CLAUDE.md de plus de 200 lignes : propose de déplacer les procédures longues (déploiement, conventions de migration, checklists) dans des skills du projet `.claude/skills/<nom>/SKILL.md`, qui ne se chargent que quand elles servent. Garde dans CLAUDE.md : stack, commandes essentielles, règles non négociables.
   - Serveurs MCP qui ne servent pas dans ce projet (ex. Higgsfield ou Microsoft 365 dans un repo de code) : désactivation par projet via `/mcp`.
   - `model` réglé sur opus/fable par défaut, ou variable `CLAUDE_CODE_SUBAGENT_MODEL` qui écrase le routage : à corriger.
   - Gros fichiers (dumps SQL, JSON générés, builds) : ajouter au `.gitignore` ou à une règle de refus de lecture (`permissions.deny` avec `Read(./chemin/**)`) dans `.claude/settings.json`.
   - Section `# Compact instructions` absente de CLAUDE.md : proposer 3-4 lignes disant ce qu'il faut garder lors d'un /compact.

4. Ne modifie rien sans accord. Termine en proposant d'appliquer les 2 ou 3 actions au meilleur gain.
