// Branche une session CLOUD (claude.ai/code) sur Agent Manager.
//
// Hors du cloud, ce fichier ne fait rien : sur un poste, les hooks viennent de
// ~/.claude/settings.json, et les déclarer deux fois enverrait chaque
// événement en double. Le jeton n'est PAS dans le dépôt : AGENT_MANAGER_URL et
// AGENT_MANAGER_TOKEN se posent dans les réglages de l'environnement cloud.
// Sans eux, le script de hook se tait.
if (process.env.CLAUDE_CODE_REMOTE === 'true') await import('./agent-manager-hook.mjs');
