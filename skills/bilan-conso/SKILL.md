---
name: bilan-conso
description: Bilan de consommation Claude Code sur les 7 derniers jours (ou une autre période) — quota hebdo, modèles utilisés, projets, sous-agents — avec 3 recommandations. À utiliser quand l'utilisateur lance /bilan-conso, demande sa conso de la semaine, ou s'inquiète d'atteindre sa limite.
model: haiku
effort: low
argument-hint: "[jours]"
---

# Bilan de consommation

1. Lance `tp-bilan $ARGUMENTS` avec Bash (7 jours si aucun argument). Si le script dit qu'il n'y a pas de données, explique que la barre d'état token-pilot enregistre la conso et propose `/token-pilot-setup`, puis rappelle que `/usage` (touche `w` pour 7 jours) donne déjà une vue officielle.

2. Présente le résultat en français, en une page courte :
   - **En bref** : quota 7 jours actuel et pic, nombre de sessions, part de la conso sur Opus/Fable.
   - Les tableaux utiles du script (par modèle, par projet), sans les recopier s'ils sont vides.
   - **3 recommandations** concrètes tirées des chiffres, par exemple :
     - part Opus en session principale > 30 % → rester sur Sonnet et passer par l'architecte ;
     - plusieurs sessions > 80 % de contexte → `/clear` entre tâches, `/compact` plus tôt ;
     - peu d'appels à l'éclaireur/vérificateur → les explorations se font sans doute dans le contexte principal ;
     - pic 5 h élevé → étaler les grosses tâches ou les lancer en sous-agents parallèles plus tôt dans la fenêtre.

3. Précise une fois que le montant en dollars est un équivalent API indicatif : sur l'abonnement Max, c'est le pourcentage de quota qui compte.
