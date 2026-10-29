#!/usr/bin/env node
// Auto-signalement vers Agent Manager, pour les sessions cloud dont les hooks
// ne se déclenchent pas (fils de projet). Usage :
//   node .claude/hooks/agent-manager-report.mjs start "tâche en cours"
//   node .claude/hooks/agent-manager-report.mjs end "résumé de la réponse"
// Ne fait rien hors du cloud ni sans AGENT_MANAGER_URL et AGENT_MANAGER_TOKEN.
// N'affiche que ce que l'application répond (une consigne, des tâches), toujours exit 0.
import {spawn} from 'node:child_process';
// `check` affiche ce que le script voit, sans rien envoyer.
import {existsSync, readdirSync, statSync} from 'node:fs';
import {homedir, hostname} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const [phase, ...words] = process.argv.slice(2);
const text = words.join(' ').trim().slice(0, 400);

/** Les transcripts de la machine, le plus récent d'abord. */
function transcripts() {
  const found = [];
  try {
    const root = join(homedir(), '.claude', 'projects');
    for (const dir of readdirSync(root)) {
      for (const file of readdirSync(join(root, dir))) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(root, dir, file);
        found.push({path, mtime: statSync(path).mtimeMs});
      }
    }
  } catch {}
  return found.sort((a, b) => b.mtime - a.mtime).map(entry => entry.path);
}

const all = transcripts();
const envSession = process.env.CLAUDE_CODE_SESSION_ID;
const transcript = envSession ? all.find(path => basename(path) === envSession + '.jsonl') : all[0];
const session = envSession || (transcript && basename(transcript, '.jsonl')) || process.env.CLAUDE_CODE_REMOTE_SESSION_ID || 'fil-' + hostname();

if (phase === 'check') {
  console.log(JSON.stringify({
    remote: process.env.CLAUDE_CODE_REMOTE ?? null,
    url: process.env.AGENT_MANAGER_URL ?? null,
    token: process.env.AGENT_MANAGER_TOKEN ? 'défini' : 'absent',
    env_session: envSession ?? null,
    session,
    transcript: transcript ?? null,
    hook: existsSync(join(dirname(fileURLToPath(import.meta.url)), 'agent-manager-hook.mjs'))
  }, null, 2));
  process.exit(0);
}

if (
  process.env.CLAUDE_CODE_REMOTE !== 'true' ||
  !process.env.AGENT_MANAGER_URL ||
  !process.env.AGENT_MANAGER_TOKEN ||
  (phase !== 'start' && phase !== 'end')
) process.exit(0);

const event = {
  hook_event_name: phase === 'start' ? 'UserPromptSubmit' : 'Stop',
  session_id: session,
  cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  transcript_path: transcript
};
if (phase === 'start') event.prompt = text || 'nouvelle demande';
else event.last_assistant_message = text || 'réponse terminée';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'agent-manager-hook.mjs');
const child = spawn(process.execPath, [hook], {stdio: ['pipe', 'pipe', 'ignore']});
let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.on('error', () => process.exit(0));
child.on('exit', () => {
  // Ce que l'application répond (consigne en file, contexte) s'affiche en clair : la session le lit.
  try {
    const reply = JSON.parse(output);
    const said = reply?.hookSpecificOutput?.additionalContext ?? reply?.reason;
    if (said) process.stdout.write('Agent Manager :\n' + said + '\n');
  } catch {}
  process.exit(0);
});
child.stdin.end(JSON.stringify(event));
