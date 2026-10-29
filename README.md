# token-pilot

Plugin Claude Code qui réduit la consommation de quota : chaque tâche part automatiquement vers le modèle le moins cher qui suffit, le contexte reste léger, et tu vois en continu où tu en es.

## Comment ça marche

La session principale tourne sur **Sonnet** et sert d'orchestrateur. À chaque demande, un hook lui rappelle les règles de routage, et elle délègue :

| Sous-agent | Modèle · effort | Pour |
|---|---|---|
| `eclaireur` | Haiku · low | explorer, chercher, lire et résumer code, logs, docs |
| `verificateur` | Haiku · low | tests, lint, typecheck, build (seules les erreurs remontent) |
| `artisan` | Sonnet · medium | implémentation claire mais volumineuse |
| `architecte` | Opus · high | conception, schéma BDD, sécurité/RLS, migrations risquées, bugs résistants |
| Fable | — | jamais automatique : proposé seulement si Opus échoue, lancé après ton accord |

Une session ouverte sur Opus ou Fable est signalée au démarrage.

## Contenu

```
.claude-plugin/plugin.json        manifeste
.claude-plugin/marketplace.json   permet d'installer depuis ce repo
agents/                           eclaireur, verificateur, artisan, architecte
skills/routage-modeles            règles détaillées (chargées au besoin)
skills/token-audit                /token-audit — audit du projet courant
skills/bilan-conso                /bilan-conso [jours] — bilan de la semaine
skills/token-pilot-setup          /token-pilot-setup — config initiale du poste
hooks/hooks.json                  UserPromptSubmit, SessionStart, SubagentStart
bin/                              scripts appelés par les hooks et les skills
tests/run.sh                      tests des scripts (lancés aussi par GitHub Actions)
```

## Installation (repo GitHub privé)

Prérequis : Claude Code récent (v2.1.292+ pour l'effort par sous-agent), `jq`, `python3`, et un accès git au repo (`gh auth login` ou clé SSH).

```sh
# dans Claude Code
/plugin marketplace add vanno/token-pilot
/plugin install token-pilot@token-pilot-marketplace
```

Puis, une seule fois par machine :

```
/token-pilot-setup
```

Ce skill règle `"model": "sonnet"` et la barre d'état dans `~/.claude/settings.json` (un plugin ne peut pas le faire seul).

## Partager avec tes associés

Le repo est privé : chaque associé doit d'abord y avoir accès.

1. **Toi, une fois par associé** : sur GitHub, *Settings → Collaborators → Add people*, rôle **Read** (suffisant pour installer et recevoir les mises à jour). L'associé accepte l'invitation reçue par mail.
2. **L'associé, sur sa machine** :
   - installer `jq` (`brew install jq` sur macOS, `sudo apt install jq` sous Linux, `winget install jqlang.jq` sous Windows) et vérifier `python3 --version` ;
   - se connecter à GitHub dans le terminal : `gh auth login` (ou une clé SSH déjà configurée) ;
   - dans Claude Code :
     ```
     /plugin marketplace add vanno/token-pilot
     /plugin install token-pilot@token-pilot-marketplace
     /token-pilot-setup
     ```
   - redémarrer Claude Code. La barre d'état doit afficher `Sonnet 5.5 · … · ctx … %`.
3. **Vérifier** : demander « explore ce repo et résume-le » doit déclencher l'`eclaireur` (Haiku).

**Mises à jour** : quand tu pousses une nouvelle version sur `main` (pense à monter `version` dans `.claude-plugin/plugin.json`), chacun lance `/plugin marketplace update token-pilot-marketplace`, puis relance `/token-pilot-setup` si la barre d'état a changé.

**Désinstaller** : `/plugin uninstall token-pilot@token-pilot-marketplace`, puis retirer `statusLine` (et `model` si voulu) de `~/.claude/settings.json`.

**En cas de souci** : `Repository not found` à l'ajout du marketplace = l'invitation GitHub n'est pas acceptée ou `gh auth login` n'est pas fait ; barre d'état « installe jq » = `jq` manquant ; routage qui ne se déclenche pas = vérifier qu'aucune variable `ANTHROPIC_MODEL` ou `CLAUDE_CODE_SUBAGENT_MODEL*` n'est définie (`/token-pilot-setup` le contrôle).

## Utilisation au quotidien

Rien à faire : travaille normalement. Pour forcer :

- « fais explorer par l'éclaireur », « demande à l'architecte » ;
- « utilise fable » pour une tâche précise ;
- `ultrathink` dans un message pour plus de réflexion sur un seul tour.

Barre d'état : `Sonnet 5.5 · medium · ctx 34% · 5h 22% · 7j 41% · $1.20`
Vert < 60 %, jaune < 85 %, rouge au-delà. À 60 % de contexte elle suggère `/compact`.

Commandes : `/token-audit`, `/bilan-conso` (rappelé automatiquement le lundi), et les commandes natives `/usage` et `/context`.

Désactiver temporairement les rappels : `TOKEN_PILOT_QUIET=1 claude`.

## Données

Les instantanés de conso restent en local dans `~/.claude/token-pilot/` (supprimés après 60 jours). Rien n'est envoyé ailleurs.

## Limites connues

- Le hook ne peut pas changer le modèle d'un tour : il guide la session, qui délègue. Le respect du routage dépend donc du modèle orchestrateur.
- Le coût en dollars est un équivalent API indicatif ; sur Max, seul le pourcentage de quota compte.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` écrase les modèles des sous-agents : à ne pas définir.
