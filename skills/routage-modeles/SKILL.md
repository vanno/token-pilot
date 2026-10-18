---
name: routage-modeles
description: Règles détaillées pour choisir le modèle (Haiku, Sonnet, Opus, Fable) et l'effort de chaque tâche, quand déléguer à un sous-agent, quand escalader, et comment garder le contexte léger. À charger quand le bon modèle pour une tâche n'est pas évident, ou quand l'utilisateur demande pourquoi un modèle a été choisi.
---

# Routage des modèles — token-pilot

La session principale tourne sur **Sonnet**. Elle joue le rôle d'orchestrateur : elle traite elle-même les tâches courantes et délègue le reste au bon sous-agent. Objectif : la qualité requise au plus bas coût de quota.

## Matrice de décision

| Tâche | Qui | Modèle · effort |
|---|---|---|
| Trouver des fichiers, localiser du code, lister des usages, lire/résumer du code, des logs ou une doc | `eclaireur` | Haiku · low |
| Lancer tests, lint, typecheck, build ; lire de longues sorties | `verificateur` | Haiku · low |
| Petites modifs (moins de ~3 fichiers), questions rapides, messages de commit, renommages | session principale | Sonnet · medium |
| Implémentation claire mais volumineuse : feature standard, bug identifié, migration Supabase simple, config Vercel/Coolify, tests | `artisan` (ou session principale si court) | Sonnet · medium |
| Conception multi-modules, schéma BDD, auth/RLS/sécurité, paiements, performance, migration risquée, revue avant prod | `architecte` | Opus · high |
| Bug qui résiste après 2 tentatives sur Sonnet | `architecte` | Opus · high |
| Problème qu'Opus n'a pas résolu, ou demande explicite « fable » | **jamais automatique** — proposer à l'utilisateur, puis Agent avec `model: "fable"` seulement s'il confirme | Fable |

Signaux qui font monter d'un cran : plusieurs services touchés (Supabase + Vercel + front), données de production, argent, sécurité, irréversibilité, ambiguïté sur le besoin.
Signaux qui font descendre : tâche mécanique, réponse qui tient dans un `grep`, simple lecture.

## Fable

Fable 5.1 peut être facturé en crédits d'usage payants en plus de l'abonnement Max. Ne jamais le choisir seul. Si un problème le justifie, dis-le en une phrase (« Opus a échoué deux fois ; Fable pourrait aider, mais ça peut consommer des crédits payants. Je lance ? ») et attends un oui.

## Plan d'abord pour les grosses tâches

Pour une feature importante : `architecte` produit le plan découpé en étapes, puis Sonnet (session ou `artisan`) exécute étape par étape. Opus réfléchit une fois, Sonnet exécute plusieurs fois.

## Hygiène de contexte

- Toute exploration de plus de 3 ou 4 lectures passe par `eclaireur` : seule sa synthèse revient dans le contexte.
- Toute commande à sortie longue passe par `verificateur`.
- Read avec `offset`/`limit` sur les gros fichiers ; ne pas relire un fichier déjà lu dans la conversation.
- Lancer les sous-agents indépendants en parallèle dans un même message.
- Quand le contexte dépasse ~60 % : suggérer `/compact <ce qu'il faut garder>`. Quand l'utilisateur change de sujet sans lien : suggérer `/clear`.
- `ultrathink` dans un prompt donne plus de réflexion pour un seul tour : préférable à basculer toute la session sur Opus.

## Transparence

Quand tu délègues, annonce-le en quelques mots (« je fais explorer par l'éclaireur (Haiku) »). Pas de justification longue.
