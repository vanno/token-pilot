#!/usr/bin/env node
import {closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';

const url = process.env.AGENT_MANAGER_URL;
const token = process.env.AGENT_MANAGER_TOKEN;
if (!url || !token) process.exit(0);

// La durée d'un outil : PreToolUse note l'heure dans un fichier, PostToolUse la relit.
const clockDir = join(tmpdir(), 'agent-manager-tools');
const clockFile = (id) => join(clockDir, String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120));

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

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const event = JSON.parse(raw);
  const hook = event.hook_event_name;

  if (hook === 'PreToolUse') {
    // Rien ne part : on note l'heure, l'envoi se fait à la fin de l'outil.
    if (event.tool_use_id) {
      mkdirSync(clockDir, {recursive: true});
      writeFileSync(clockFile(event.tool_use_id), String(Date.now()));
    }
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
    event.origin = process.env.CLAUDE_CODE_REMOTE === 'true' ? 'cloud' : 'local';
    event.host = hostname();
    if (event.cwd) {
      const branch = gitBranch(event.cwd);
      if (branch) event.git_branch = branch;
    }
  }

  if (hook === 'SessionStart') {
    // Les horloges d'outils interrompus ne s'accumulent pas : plus d'un jour, on les jette.
    try {
      for (const name of readdirSync(clockDir)) {
        const file = join(clockDir, name);
        if (Date.now() - statSync(file).mtimeMs > 86_400_000) unlinkSync(file);
      }
    } catch {}
  }

  await fetch(url.replace(/\/+$/, '') + '/api/ingest', {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer ' + token},
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(4000)
  });
} catch {}
process.exit(0);
