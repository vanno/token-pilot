// Branche une session CLOUD (claude.ai/code) sur Agent Manager.
//
// Hors du cloud, ce fichier ne fait rien : sur un poste, les hooks viennent de
// ~/.claude/settings.json, et les déclarer deux fois enverrait chaque
// événement en double. Pour la même raison, il se tait quand l'environnement
// cloud a installé le script dans ~/.claude (script de configuration servi par
// /api/ingest/setup) : ce sont alors les hooks de l'utilisateur qui envoient.
// Le jeton n'est PAS dans le dépôt : AGENT_MANAGER_URL et AGENT_MANAGER_TOKEN
// se posent dans les réglages de l'environnement cloud. Sans eux, le script de
// hook se tait.
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

if (process.env.CLAUDE_CODE_REMOTE === 'true' && !existsSync(join(homedir(), '.claude', 'agent-manager-hook.mjs'))) {
  await import('./agent-manager-hook.mjs');
}
