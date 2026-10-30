#!/usr/bin/env node
// Auto-signalement vers Agent Manager, pour les sessions cloud dont les hooks
// ne se déclenchent pas (fils de projet). Usage :
//   node .claude/hooks/agent-manager-report.mjs start "tâche en cours"
//   node .claude/hooks/agent-manager-report.mjs end "résumé de la réponse"
//   node .claude/hooks/agent-manager-report.mjs check   (affiche ce que le script voit, sans rien envoyer)
// Ne fait rien hors du cloud ni sans AGENT_MANAGER_URL et AGENT_MANAGER_TOKEN.
// Se tait aussi quand les hooks natifs tournent déjà : ils envoient la même
// demande et la même fin de tour, le signalement les doublerait.
// `end` rejoue d'abord les réponses de list_triggers et get_trigger de la
// dernière demi-heure, lues dans le journal de la session : sans hook natif,
// personne ne les a envoyées, et Agent Manager en tire les tâches planifiées
// de claude.ai (lot 2026-10-30-releve-fils).
// N'affiche que ce que l'application répond (une consigne, des tâches), toujours exit 0.
import {spawn} from 'node:child_process';
import {closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync} from 'node:fs';
import {homedir, hostname, tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const [phase, ...words] = process.argv.slice(2);
const text = words.join(' ').trim().slice(0, 400);

// Le script de hook suit une liste page par page pendant trente minutes : rien de plus vieux ne se rejoue.
const REPLAY_MS = 30 * 60_000;
// La fin du journal suffit : une demi-heure de travail y tient, pages de 45 000 signes comprises.
const TAIL_BYTES = 8 * 1024 * 1024;
const SCHEDULE_TOOL = /^mcp__claude[-_]code[-_]remote__(list_triggers|get_trigger)$/i;
const replayDir = join(tmpdir(), 'agent-manager-replayed');

/** Les transcripts de la machine, le plus récent d'abord. */
function transcripts() {
  const found = [];
  const root = join(homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = readdirSync(root); } catch {}
  for (const dir of dirs) {
    try {
      for (const file of readdirSync(join(root, dir))) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(root, dir, file);
        found.push({path, mtime: statSync(path).mtimeMs});
      }
    } catch {}
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(entry => entry.path);
}

// Le hook natif note l'heure de chaque outil dans ce dossier (PreToolUse). Ce script
// est lui-même lancé par un outil : une note de moins de deux minutes prouve que les
// hooks de la session tournent.
function nativeHooksLive() {
  const dir = join(tmpdir(), 'agent-manager-tools');
  try {
    return readdirSync(dir).some((name) => Date.now() - statSync(join(dir, name)).mtimeMs < 120_000);
  } catch {}
  return false;
}

/** La fin du journal, en lignes entières. */
function tailLines(path) {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {}
  return [];
}

/** Les réponses réussies de list_triggers et get_trigger écrites après `after`, dans l'ordre du journal. */
function schedulePages(path, after) {
  const asked = new Map();
  const pages = [];
  for (const line of tailLines(path)) {
    if (!line.includes('_trigger') && ![...asked.keys()].some((id) => line.includes(id))) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const parts = entry?.message?.content;
    if (!Array.isArray(parts)) continue;
    const at = Date.parse(entry.timestamp);
    for (const part of parts) {
      if (part?.type === 'tool_use' && typeof part.id === 'string' && SCHEDULE_TOOL.test(String(part.name))) {
        asked.set(part.id, {name: part.name, input: part.input ?? {}, at});
        continue;
      }
      if (part?.type !== 'tool_result' || !asked.has(part.tool_use_id)) continue;
      const use = asked.get(part.tool_use_id);
      asked.delete(part.tool_use_id);
      if (part.is_error === true || !(at > after)) continue;
      pages.push({id: part.tool_use_id, name: use.name, input: use.input, response: part.content, at, duration: at >= use.at ? at - use.at : null});
    }
  }
  return pages;
}

// Ce qui a déjà été rejoué pour la session : l'heure de la dernière réponse envoyée.
const replayFile = (session) => join(replayDir, String(session).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120) || 'session');
function replayedUntil(session) {
  try {
    const at = Number(readFileSync(replayFile(session), 'utf8'));
    if (at > 0) return at;
  } catch {}
  return 0;
}
function markReplayed(session, at) {
  try {
    mkdirSync(replayDir, {recursive: true});
    writeFileSync(replayFile(session), String(at));
  } catch {}
}

// La copie installée dans ~/.claude se met à jour seule : elle passe avant celle du dépôt.
const installed = join(homedir(), '.claude', 'agent-manager-hook.mjs');
const hook = existsSync(installed) ? installed : join(dirname(fileURLToPath(import.meta.url)), 'agent-manager-hook.mjs');

/** Un événement passé au script de hook, comme Claude Code le ferait ; rend ce qu'il affiche. */
function runHook(event) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook], {stdio: ['pipe', 'pipe', 'ignore']});
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.on('error', () => resolve(''));
    child.on('exit', () => resolve(output));
    child.stdin.end(JSON.stringify(event));
  });
}

if (phase === 'check') {
  const all = transcripts();
  const envSession = process.env.CLAUDE_CODE_SESSION_ID;
  const transcript = (envSession ? all.find(path => basename(path) === envSession + '.jsonl') : all[0]) ?? null;
  const session = envSession || process.env.CLAUDE_CODE_REMOTE_SESSION_ID || null;
  console.log(JSON.stringify({
    remote: process.env.CLAUDE_CODE_REMOTE ?? null,
    url: process.env.AGENT_MANAGER_URL ?? null,
    token: process.env.AGENT_MANAGER_TOKEN ? 'défini' : 'absent',
    env_session: envSession ?? null,
    session,
    transcript,
    hook: existsSync(hook) ? hook : null,
    native_hooks: nativeHooksLive(),
    schedule_pages: transcript ? schedulePages(transcript, Math.max(replayedUntil(session), Date.now() - REPLAY_MS)).length : 0
  }, null, 2));
  process.exit(0);
}

if (
  process.env.CLAUDE_CODE_REMOTE !== 'true' ||
  !process.env.AGENT_MANAGER_URL ||
  !process.env.AGENT_MANAGER_TOKEN ||
  (phase !== 'start' && phase !== 'end') ||
  nativeHooksLive()
) process.exit(0);

const all = transcripts();
const envSession = process.env.CLAUDE_CODE_SESSION_ID;
const transcript = envSession ? all.find(path => basename(path) === envSession + '.jsonl') : all[0];
const session = envSession || (transcript && basename(transcript, '.jsonl')) || process.env.CLAUDE_CODE_REMOTE_SESSION_ID || 'fil-' + hostname();
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Les pages d'abord, une à une dans l'ordre : le script de hook enchaîne une liste par son curseur.
if (phase === 'end' && transcript) {
  for (const page of schedulePages(transcript, Math.max(replayedUntil(session), Date.now() - REPLAY_MS))) {
    await runHook({
      hook_event_name: 'PostToolUse',
      session_id: session,
      cwd,
      tool_name: page.name,
      tool_input: page.input,
      tool_response: page.response,
      tool_use_id: page.id,
      ...(page.duration === null ? {} : {duration_ms: page.duration})
    });
    markReplayed(session, page.at);
  }
}

const event = {
  hook_event_name: phase === 'start' ? 'UserPromptSubmit' : 'Stop',
  session_id: session,
  cwd,
  transcript_path: transcript
};
if (phase === 'start') event.prompt = text || 'nouvelle demande';
else event.last_assistant_message = text || 'réponse terminée';

// Ce que l'application répond (consigne en file, contexte) s'affiche en clair : la session le lit.
try {
  const reply = JSON.parse(await runHook(event));
  const said = reply?.hookSpecificOutput?.additionalContext ?? reply?.reason;
  if (said) process.stdout.write('Agent Manager :\n' + said + '\n');
} catch {}
process.exit(0);
