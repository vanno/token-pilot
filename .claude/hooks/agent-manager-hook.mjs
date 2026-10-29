#!/usr/bin/env node
import {closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir, hostname, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const VERSION = '97a30810629a';
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

function gitBranch(cwd) {
  try {
    const branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8'}).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {}
  return null;
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

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const event = JSON.parse(raw);
  const hook = event.hook_event_name;

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
  // On ne renvoie jamais la réponse d'un outil : elle peut porter n'importe quoi.
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
  }
  delete event.transcript_path;
  delete event.agent_transcript_path;

  if (hook === 'SessionStart' || hook === 'UserPromptSubmit' || hook === 'Stop') {
    event.origin = process.env.CLAUDE_CODE_PROJECTS_SESSION === '1' ? 'project' : process.env.CLAUDE_CODE_REMOTE === 'true' ? 'cloud' : 'local';
    event.host = hostname();
    event.hook_version = VERSION;
    if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) event.remote_session = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
    if (event.cwd) {
      const branch = gitBranch(event.cwd);
      if (branch) event.git_branch = branch;
    }
  }

  if (hook === 'SessionStart') {
    // Les horloges d'outils interrompus et les politiques oubliées ne s'accumulent pas : plus d'un jour, on les jette.
    for (const dir of [clockDir, policyDir]) {
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

  if ((hook === 'SessionStart' || hook === 'UserPromptSubmit') && control?.context) {
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
          answer({hookSpecificOutput: {hookEventName: 'PermissionRequest', decision: {behavior: 'allow'}}});
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
