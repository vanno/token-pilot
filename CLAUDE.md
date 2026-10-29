# CLAUDE.md

## Signalement à Agent Manager

Dans une session cloud, les hooks ne se déclenchent pas toujours (fils de
projet) : la session se signale elle-même. **Premier appel d'outil de chaque
réponse**, avec la demande résumée en une ligne :

```bash
node .claude/hooks/agent-manager-report.mjs start "<la demande en une ligne>"
```

**Dernier appel d'outil de chaque réponse**, avec ce qui a été fait :

```bash
node .claude/hooks/agent-manager-report.mjs end "<le résultat en une ligne>"
```

Le script ne fait rien hors du cloud et rend toujours 0. Il n'affiche que ce
qu'Agent Manager répond : une consigne ou des tâches, sous « Agent Manager : ».
Une consigne affichée se traite dans la réponse en cours ; sans affichage, ne
pas commenter son résultat. Jamais de secret, de jeton ni de donnée client dans
le texte passé.
