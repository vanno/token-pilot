#!/usr/bin/env node
import {closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {execFileSync, spawn} from 'node:child_process';
import {homedir, hostname, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const VERSION = '9a9bea9c568f';
const url = process.env.AGENT_MANAGER_URL;
const token = process.env.AGENT_MANAGER_TOKEN;
if (!url || !token) process.exit(0);
const base = url.replace(/\/+$/, '');

// La durée d'un outil : PreToolUse note l'heure dans un fichier, PostToolUse la relit.
const clockDir = join(tmpdir(), 'agent-manager-tools');
const clockFile = (id) => join(clockDir, String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120));

// La politique d'une session (arrêt, garde-fous, attente de validation), gardée quelques secondes.
const policyDir = join(tmpdir(), 'agent-manager-policy');
const POLICY_FRESH_MS = 15_000;
const POLICY_STALE_MS = 10 * 60_000;

// L'attente d'une session au repos : une seule par session, la plus récente prend le relais.
const waitDir = join(tmpdir(), 'agent-manager-wait');
const WAIT_MS = 50 * 60_000;
// Le rythme de relève se règle pour les tests ; sinon 10 s, puis 30 s après dix minutes.
const WAIT_POLL_MS = Number(process.env.AGENT_MANAGER_WAIT_POLL_MS) || 0;

// Les productions : ce qu'on repère, et les listes de fichiers à déposer, relues par le processus détaché.
const uploadDir = join(tmpdir(), 'agent-manager-upload');
const PRODUCED = /\.(png|jpe?g|gif|webp|avif|mp4|m4v|webm|mov|mp3|wav|ogg|m4a|pdf|docx|xlsx|pptx|odt|ods|odp|csv)$/i;
const OUTPUT_MAX = 25 * 1024 * 1024;

function tail(path, bytes) {
  const size = statSync(path).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  readSync(fd, buffer, 0, length, size - length);
  closeSync(fd);
  return buffer.toString('utf8').split('\n').reverse();
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// Le contexte : les jetons d'entrée du dernier message de l'assistant.
function lastUsage(path) {
  try {
    for (const line of tail(path, 256 * 1024)) {
      if (!line.includes('"usage"')) continue;
      const entry = parse(line);
      const usage = entry?.message?.usage;
      if (entry?.type !== 'assistant' || !usage) continue;
      const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      return {tokens, model: entry.message.model};
    }
  } catch {}
  return null;
}

// Les jetons d'un tour : chaque appel au modèle depuis le dernier prompt humain, une fois par message.
function turnUsage(path) {
  try {
    const seen = new Set();
    const total = {input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0};
    for (const line of tail(path, 4 * 1024 * 1024)) {
      const entry = parse(line);
      if (!entry) continue;
      if (entry.type === 'user') {
        const content = entry.message?.content;
        const human = typeof content === 'string' || (Array.isArray(content) && content.some((part) => part?.type === 'text'));
        if (human && !entry.isMeta) break;
        continue;
      }
      const usage = entry.message?.usage;
      if (entry.type !== 'assistant' || !usage) continue;
      const id = entry.message.id ?? entry.uuid;
      if (seen.has(id)) continue;
      seen.add(id);
      total.input_tokens += usage.input_tokens ?? 0;
      total.output_tokens += usage.output_tokens ?? 0;
      total.cache_read_tokens += usage.cache_read_input_tokens ?? 0;
      total.cache_write_tokens += usage.cache_creation_input_tokens ?? 0;
    }
    return seen.size > 0 ? total : null;
  } catch {}
  return null;
}

// Le titre de la session : le dernier donné à la main (/rename), sinon le dernier que Claude Code a trouvé.
function sessionTitle(path) {
  try {
    // Les lignes viennent de la plus récente à la plus ancienne.
    let found = null;
    let summary = null;
    for (const line of tail(path, 256 * 1024)) {
      if (!line.includes('-title"') && !line.includes('"summary"')) continue;
      const entry = parse(line);
      if (entry?.type === 'custom-title' && typeof entry.customTitle === 'string') return entry.customTitle.slice(0, 200) || null;
      if (entry?.type === 'ai-title' && typeof entry.aiTitle === 'string') found ??= entry.aiTitle;
      else if (entry?.type === 'summary' && typeof entry.summary === 'string') summary ??= entry.summary;
    }
    return (found ?? summary)?.slice(0, 200) || null;
  } catch {}
  return null;
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8'}).trim() || null;
  } catch {}
  return null;
}

// Le dépôt où travaille la session : celui du dossier, sinon le plus récemment touché juste en dessous.
function repoDir(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top) return top;
  let best = null;
  try {
    for (const entry of readdirSync(cwd, {withFileTypes: true}).slice(0, 80)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        const at = statSync(join(cwd, entry.name, '.git')).mtimeMs;
        if (!best || at > best.at) best = {dir: join(cwd, entry.name), at};
      } catch {}
    }
  } catch {}
  return best?.dir ?? null;
}

// « propriétaire/nom » d'après le remote, sinon le nom du dossier.
function repoName(dir) {
  const slug = /([A-Za-z0-9_.-]+)[/:]([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(git(dir, ['remote', 'get-url', 'origin']) ?? '');
  return slug ? slug[1] + '/' + slug[2] : (dir.split(/[\\/]/).pop() || null);
}

async function call(path, body, ms) {
  try {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer ' + token},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms)
    });
    if (!response.ok) return null;
    return (await response.json())?.data ?? null;
  } catch {}
  return null;
}

async function policyFor(session) {
  const file = join(policyDir, String(session).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120) || 'session');
  let cached = null;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (cached && Date.now() - cached.at < POLICY_FRESH_MS) return cached.policy;
  const policy = await call('/api/control/policy', {session}, 2500);
  if (policy) {
    try {
      mkdirSync(policyDir, {recursive: true});
      writeFileSync(file, JSON.stringify({at: Date.now(), policy}));
    } catch {}
    return policy;
  }
  // L'application ne répond pas : la dernière politique connue tient encore un moment, puis plus rien ne bloque.
  return cached && Date.now() - cached.at < POLICY_STALE_MS ? cached.policy : null;
}

// Le texte d'une réponse d'outil : la sortie d'une commande, le contenu d'un fichier, le texte d'un outil MCP.
function resultText(response) {
  if (response === undefined || response === null) return '';
  if (typeof response === 'string') return response;
  const parts = Array.isArray(response) ? response : Array.isArray(response.content) ? response.content : null;
  if (parts) return parts.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('\n');
  if (typeof response.stdout === 'string' || typeof response.stderr === 'string') return [response.stdout, response.stderr].filter(Boolean).join('\n');
  if (typeof response.file?.content === 'string') return response.file.content;
  if (typeof response.content === 'string') return response.content;
  return JSON.stringify(response);
}

// Les programmes qui lisent sans rien publier : une commande faite d'eux seuls cite des liens et des chemins, elle n'en produit aucun.
const READERS = new Set(['cat', 'head', 'tail', 'sed', 'grep', 'egrep', 'rg', 'awk', 'less', 'more', 'jq', 'ls', 'find', 'wc', 'diff', 'nl', 'cut', 'sort', 'uniq', 'tr', 'echo', 'printf', 'cd', 'pwd', 'stat', 'file', 'which', 'true']);
const GIT_READS = new Set(['log', 'show', 'diff', 'status', 'blame', 'grep']);

function onlyReads(command) {
  const text = String(command ?? '');
  // Une redirection vers un fichier écrit quelque chose : ce n'est plus une lecture.
  if (/(^|[^0-9&])>>?\s*(?!&|\/dev\/null)/.test(text)) return false;
  const parts = text.split(/&&|\|\||;|\||\n/).map((part) => part.trim().split(/\s+/)).filter((words) => words[0]);
  return parts.length > 0 && parts.every(([head, next]) => READERS.has(head) || (head === 'git' && GIT_READS.has(next ?? '')));
}

// Ce que l'outil a produit : le fichier qu'il a écrit, et pour une commande, un sous-agent ou un outil MCP,
// les liens publiés et les fichiers que sa réponse cite, s'ils ont été écrits pendant l'outil (un find ou un ls ne produit rien).
function outputsOf(event, text) {
  const found = new Map();
  const add = (key, output) => {
    if (!found.has(key) && found.size < 12) found.set(key, output);
  };
  const since = Date.now() - (typeof event.duration_ms === 'number' ? event.duration_ms : 10 * 60_000) - 5_000;
  const file = (raw, written) => {
    const path = resolve(event.cwd || process.cwd(), String(raw));
    if (!PRODUCED.test(path)) return;
    try {
      const stat = statSync(path);
      if (stat.isFile() && (written || stat.mtimeMs >= since)) add(path, {kind: 'file', path, bytes: stat.size});
    } catch {}
  };
  const tool = String(event.tool_name ?? '');
  const input = event.tool_input ?? {};
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) && typeof input.file_path === 'string') file(input.file_path, true);
  if (tool !== 'Bash' && tool !== 'Task' && tool !== 'Agent' && !tool.startsWith('mcp__')) return [...found.values()];
  if (tool === 'Bash' && onlyReads(input.command)) return [...found.values()];
  const sample = text.slice(0, 200_000);
  for (const match of sample.matchAll(/https:\/\/[^\s"'<>()\[\]{}\\]+/g)) {
    const link = match[0].replace(/[.,;:!?]+$/, '');
    // Un lien abrégé (« https://…/rapport.pdf ») est un exemple, pas une adresse.
    if (link.includes('…')) continue;
    const kind = /^https:\/\/claude\.ai\/(code\/)?artifact\//.test(link)
      ? 'artifact'
      : /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(link)
        ? 'pr'
        : PRODUCED.test(link.split(/[?#]/)[0])
          ? 'link'
          : null;
    if (kind) add(link, {kind, url: link});
  }
  for (const match of sample.matchAll(/(?:^|[\s"'(=:])(\/[^\s"'<>()|;:]+\.[A-Za-z0-9]{2,4})(?=[\s"'),;:]|\.(?:\s|$)|$)/gm)) file(match[1], false);
  return [...found.values()];
}

// Ce qu'un garde-fou relit : la commande pour Bash, le chemin pour un fichier, tout l'appel pour « * ».
function guardSubject(guard, tool, input) {
  const files = {Edit: /^(Edit|MultiEdit|NotebookEdit)$/, Write: /^Write$/, Read: /^(Read|Glob|Grep)$/};
  if (guard.tool === '*') return JSON.stringify(input ?? {});
  if (guard.tool === 'Bash') return tool === 'Bash' ? String(input?.command ?? '') : null;
  if (!files[guard.tool]?.test(tool)) return null;
  return String(input?.file_path ?? input?.notebook_path ?? input?.path ?? input?.pattern ?? '');
}

function deniedBy(policy, tool, input) {
  if (policy?.halted) return {reason: 'Arrêt demandé depuis Agent Manager : ' + policy.halted, halt: true};
  for (const guard of policy?.guards ?? []) {
    const subject = guardSubject(guard, tool, input);
    if (subject === null) continue;
    let pattern;
    try { pattern = new RegExp(guard.pattern); } catch { continue; }
    if (pattern.test(subject)) return {reason: 'Garde-fou Agent Manager « ' + guard.label + ' »', halt: false};
  }
  return null;
}

// La copie installée dans ~/.claude se remplace par la version courante ; une copie d'un dépôt, jamais.
function installedHere() {
  try {
    const own = resolve(fileURLToPath(import.meta.url));
    const home = resolve(join(homedir(), '.claude', 'agent-manager-hook.mjs'));
    return process.platform === 'win32' ? own.toLowerCase() === home.toLowerCase() : own === home;
  } catch {}
  return false;
}

async function selfUpdate(latest) {
  if (!latest || latest === VERSION || !/^[a-f0-9]{6,40}$/.test(latest) || !installedHere()) return;
  try {
    const response = await fetch(base + '/api/ingest/hook', {signal: AbortSignal.timeout(3000)});
    if (!response.ok) return;
    const script = await response.text();
    if (!script.startsWith('#!/usr/bin/env node') || !script.includes("const VERSION = '" + latest + "'") || script.length > 200_000) return;
    const own = fileURLToPath(import.meta.url);
    writeFileSync(own + '.next', script);
    renameSync(own + '.next', own);
  } catch {}
}

function answer(output) {
  process.stdout.write(JSON.stringify(output));
}

// La session au repos relève sa boîte : toutes les 10 s les dix premières minutes, puis toutes les 30 s.
async function waitForInstruction(session) {
  const file = join(waitDir, String(session).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120) || 'session');
  const mine = process.pid + '-' + Date.now();
  try {
    mkdirSync(waitDir, {recursive: true});
    writeFileSync(file, mine);
  } catch {
    return;
  }
  const owned = () => {
    try { return readFileSync(file, 'utf8') === mine; } catch {}
    return false;
  };
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS || (Date.now() - started < 10 * 60_000 ? 10_000 : 30_000)));
    if (!owned()) return;
    const inbox = await call('/api/control/inbox', {session}, 5000);
    if (inbox?.stop) break;
    if (inbox?.instruction) {
      try { unlinkSync(file); } catch {}
      process.stderr.write(String(inbox.instruction));
      process.exit(2);
    }
  }
  if (owned()) {
    try { unlinkSync(file); } catch {}
  }
}

// Le dépôt des fichiers produits, lancé détaché après l'envoi de l'événement qui les a rangés.
const uploadAt = process.argv.indexOf('upload');
if (uploadAt > 1) {
  try {
    const listFile = process.argv[uploadAt + 1];
    const list = JSON.parse(readFileSync(listFile, 'utf8'));
    unlinkSync(listFile);
    for (const item of (list.files ?? []).slice(0, 12)) {
      let size = -1;
      try { size = statSync(item.path).size; } catch {}
      if (size < 0 || size > OUTPUT_MAX) continue;
      // Trois essais, à 2 puis 4 secondes : un réseau qui coupe ou une application qui redémarre ne perdent plus le fichier.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((done) => setTimeout(done, attempt * 2000));
        try {
          const response = await fetch(base + '/api/ingest/output?session=' + encodeURIComponent(list.session) + '&path=' + encodeURIComponent(item.path), {
            method: 'POST',
            headers: {'content-type': 'application/octet-stream', authorization: 'Bearer ' + token},
            body: readFileSync(item.path),
            signal: AbortSignal.timeout(120_000)
          });
          // Déposé, ou refusé pour de bon (non permis, trop gros) : seul un serveur en panne ou débordé vaut un nouvel essai.
          if (response.status < 500 && response.status !== 429) break;
        } catch {}
      }
    }
  } catch {}
  process.exit(0);
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const event = JSON.parse(raw);
  const hook = event.hook_event_name;

  if (process.argv.includes('wait')) {
    // Seule une session racine attend, à son démarrage ou à la fin d'un tour.
    if ((hook === 'Stop' || hook === 'SessionStart') && !event.agent_id && event.session_id) await waitForInstruction(event.session_id);
    process.exit(0);
  }

  if (hook === 'PreToolUse') {
    // Rien ne part tant que rien n'est refusé : on note l'heure, l'envoi se fait à la fin de l'outil.
    if (event.tool_use_id) {
      mkdirSync(clockDir, {recursive: true});
      writeFileSync(clockFile(event.tool_use_id), String(Date.now()));
    }
    const denied = deniedBy(await policyFor(event.session_id), event.tool_name, event.tool_input);
    if (!denied) process.exit(0);
    answer({
      ...(denied.halt ? {continue: false, stopReason: denied.reason} : {}),
      hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denied.reason}
    });
    delete event.transcript_path;
    delete event.agent_transcript_path;
    await call('/api/ingest', {...event, agent_manager_denied: denied.reason}, 2000);
    process.exit(0);
  }

  if ((hook === 'PostToolUse' || hook === 'PostToolUseFailure') && event.tool_use_id && typeof event.duration_ms !== 'number') {
    try {
      const file = clockFile(event.tool_use_id);
      const started = Number(readFileSync(file, 'utf8'));
      unlinkSync(file);
      if (started > 0) event.duration_ms = Math.max(Date.now() - started, 0);
    } catch {}
  }
  // La réponse d'un outil peut porter n'importe quoi : sa taille part toujours, un extrait seulement si l'organisation l'a permis.
  let produced = [];
  if ((hook === 'PostToolUse' || hook === 'PostToolUseFailure') && 'tool_response' in event) {
    const text = resultText(event.tool_response);
    event.tool_result_chars = text.length;
    if (text && (await policyFor(event.session_id))?.tool_results === true) event.tool_result = text.slice(0, 6000);
    if (hook === 'PostToolUse') produced = outputsOf(event, text);
    if (produced.length) event.agent_manager_outputs = produced;
  }
  delete event.tool_response;

  if (event.transcript_path && !event.agent_id && hook !== 'SessionEnd') {
    const usage = lastUsage(event.transcript_path);
    if (usage) {
      event.context_tokens = usage.tokens;
      if (usage.model && !event.model) event.model = usage.model;
      const limit = Number(process.env.AGENT_MANAGER_CONTEXT_LIMIT);
      if (limit > 0) event.context_limit = limit;
    }
    if (hook === 'Stop' || hook === 'StopFailure') {
      const turn = turnUsage(event.transcript_path);
      if (turn) event.turn_usage = turn;
    }
    if (hook === 'SessionStart' || hook === 'UserPromptSubmit' || hook === 'Stop') {
      const title = sessionTitle(event.transcript_path);
      if (title) event.title = title;
    }
  }
  delete event.transcript_path;
  delete event.agent_transcript_path;

  if (hook === 'SessionStart' || hook === 'UserPromptSubmit' || hook === 'Stop') {
    event.origin = process.env.CLAUDE_CODE_PROJECTS_SESSION === '1' ? 'project' : process.env.CLAUDE_CODE_REMOTE === 'true' ? 'cloud' : 'local';
    event.host = hostname();
    event.hook_version = VERSION;
    if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) event.remote_session = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
    const dir = event.cwd ? repoDir(event.cwd) : null;
    if (dir) {
      // Rien sur une tête détachée ; un dépôt sans commit a déjà sa branche.
      const branch = git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
      if (branch) event.git_branch = branch;
      const repo = repoName(dir);
      if (repo) event.repo = repo;
    }
  }

  if (hook === 'SessionStart') {
    // Les horloges d'outils interrompus et les politiques oubliées ne s'accumulent pas : plus d'un jour, on les jette.
    for (const dir of [clockDir, policyDir, waitDir, uploadDir]) {
      try {
        for (const name of readdirSync(dir)) {
          const file = join(dir, name);
          if (Date.now() - statSync(file).mtimeMs > 86_400_000) unlinkSync(file);
        }
      } catch {}
    }
  }

  const reply = await call('/api/ingest', event, 4000);
  const control = reply?.control;
  if (hook === 'SessionStart') await selfUpdate(reply?.hook);

  // Le contenu des fichiers produits, si l'organisation le permet : un processus détaché le dépose, l'agent n'attend pas.
  const files = produced.filter((output) => output.kind === 'file' && output.bytes > 0 && output.bytes <= OUTPUT_MAX);
  if (reply && files.length && (await policyFor(event.session_id))?.outputs === true) {
    try {
      mkdirSync(uploadDir, {recursive: true});
      const listFile = join(uploadDir, process.pid + '-' + Date.now() + '.json');
      writeFileSync(listFile, JSON.stringify({session: event.session_id, files}));
      spawn(process.execPath, [fileURLToPath(import.meta.url), 'upload', listFile], {detached: true, stdio: 'ignore', env: process.env}).unref();
    } catch {}
  }

  if ((hook === 'SessionStart' || hook === 'UserPromptSubmit') && control?.context) {
    answer({hookSpecificOutput: {hookEventName: hook, additionalContext: control.context}});
  } else if ((hook === 'PostToolUse' || hook === 'PostToolUseFailure') && control?.context) {
    // Une consigne pour cet agent, remise pendant qu'il travaille.
    answer({hookSpecificOutput: {hookEventName: hook, additionalContext: control.context}});
  } else if (hook === 'Stop' && control?.instruction) {
    // Une consigne en file relance le tour, avec elle pour seule demande.
    answer({decision: 'block', reason: control.instruction});
  } else if (hook === 'PermissionRequest') {
    const policy = await policyFor(event.session_id);
    if (policy?.halted) {
      answer({hookSpecificOutput: {hookEventName: 'PermissionRequest', decision: {behavior: 'deny', message: 'Arrêt demandé depuis Agent Manager : ' + policy.halted, interrupt: true}}});
    } else if (control?.approval) {
      // La validation à distance : on attend la décision de l'écran, puis la fenêtre locale reprend la main.
      const deadline = Date.now() + Math.min(Number(control.wait) || 0, 300) * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const state = await call('/api/control/approvals/' + encodeURIComponent(control.approval), undefined, 3000);
        if (state?.state === 'allow') {
          // Une question répondue à l'écran : ses réponses, par texte de question, dans l'entrée de l'outil (AskUserQuestion seul).
          const answers = event.tool_name === 'AskUserQuestion' && state.answers && typeof state.answers === 'object' ? state.answers : null;
          const decision = answers ? {behavior: 'allow', updatedInput: {...event.tool_input, answers}} : {behavior: 'allow'};
          answer({hookSpecificOutput: {hookEventName: 'PermissionRequest', decision}});
          break;
        }
        if (state?.state === 'deny') {
          answer({hookSpecificOutput: {hookEventName: 'PermissionRequest', decision: {behavior: 'deny', message: 'Refusé depuis Agent Manager' + (state.message ? ' : ' + state.message : '.')}}});
          break;
        }
        if (state?.state === 'expired') break;
      }
    }
  }
} catch {}
process.exit(0);
