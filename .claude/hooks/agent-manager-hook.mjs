#!/usr/bin/env node
import {appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync, execSync, spawn} from 'node:child_process';
import {homedir, hostname, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const VERSION = '6148c8021052';
const url = process.env.AGENT_MANAGER_URL;
const token = process.env.AGENT_MANAGER_TOKEN;
// Sans adresse ni jeton, rien ne part ; seule la barre d'état continue d'afficher ce qu'elle afficherait.
if ((!url || !token) && !process.argv.includes('statusline')) process.exit(0);
const base = (url ?? '').replace(/\/+$/, '');

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

// La copie des fichiers modifiés : les chemins écrits pendant un tour, envoyés à sa fin, et l'empreinte de ce qui est déjà parti.
const copyDir = join(tmpdir(), 'agent-manager-copies');
const COPY_MAX = 10 * 1024 * 1024;
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Une image ou un PDF lu part aussi en copie (même motif que READ_COPY_PATTERN de lib/live/files.ts).
const READ_COPY = /\.(png|jpe?g|gif|webp|avif|pdf)$/i;
// Un fichier de secrets ne part jamais en copie (même motif que SECRET_PATTERN de lib/live/files.ts).
const SECRET_FILE = /^(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|\.envrc|\.dev\.vars|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml|env)|service[-_]?account[^/]*\.json|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate))$/i;
const copyFile = (session, suffix) => join(copyDir, String(session).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120) + suffix);

// Le nom d'un sous-agent : la description que la session donne à l'outil Agent, notée avant son départ, reprise à son démarrage.
const namesDir = join(tmpdir(), 'agent-manager-names');
const namePrefix = (session) => String(session).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120) + '.';
const NAME_FRESH_MS = 60_000;

// Les tâches planifiées de claude.ai : la réponse de leur outil, et la liste lue page par page, suivie dans un fichier par session.
const schedulesDir = join(tmpdir(), 'agent-manager-schedules');
const SCHEDULE_TOOL = /^mcp__claude[-_]code[-_]remote__(list_triggers|get_trigger)$/i;
const SCHEDULE_CHAIN_MS = 30 * 60_000;

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

// Un appel de l'outil Agent laisse un billet : la sorte demandée et la description, dans l'ordre des départs.
function noteName(session, input) {
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  if (!session || !description) return;
  try {
    mkdirSync(namesDir, {recursive: true});
    const type = typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'general-purpose';
    writeFileSync(join(namesDir, namePrefix(session) + Date.now() + '-' + process.pid), JSON.stringify({type, description: description.slice(0, 300)}));
  } catch {}
}

// Le sous-agent qui démarre prend le plus ancien billet de sa sorte. Le renommage est atomique : deux départs simultanés ne prennent pas le même.
function claimName(session, agentType) {
  const wanted = String(agentType || 'general-purpose').toLowerCase();
  let names = [];
  try {
    names = readdirSync(namesDir).filter((name) => name.startsWith(namePrefix(session)) && !name.endsWith('.taken')).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const file = join(namesDir, name);
    try {
      if (Date.now() - statSync(file).mtimeMs > NAME_FRESH_MS) {
        unlinkSync(file);
        continue;
      }
      const ticket = JSON.parse(readFileSync(file, 'utf8'));
      if (String(ticket?.type || 'general-purpose').toLowerCase() !== wanted) continue;
      renameSync(file, file + '.taken');
      unlinkSync(file + '.taken');
      return typeof ticket.description === 'string' ? ticket.description : null;
    } catch {}
  }
  return null;
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

// L'identifiant de l'étape que TaskCreate vient d'ajouter au plan : {task: {id}}, sinon « Task #3 created ».
function createdStepId(response) {
  const id = response?.task?.id;
  if ((typeof id === 'string' || typeof id === 'number') && /^[A-Za-z0-9_-]{1,40}$/.test(String(id))) return String(id);
  const found = /Task #([A-Za-z0-9_-]{1,40}) created/.exec(resultText(response));
  return found ? found[1] : null;
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

// Les valeurs JSON d'une réponse d'outil MCP, partie par partie : une note en texte suit parfois la page.
function jsonParts(response) {
  const parts = Array.isArray(response) ? response : Array.isArray(response?.content) ? response.content : [response];
  const found = [];
  for (const part of parts) {
    const text = typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : null;
    const value = text === null ? part : parse(text.trim());
    if (value && typeof value === 'object' && !Array.isArray(value)) found.push(value);
  }
  return found;
}

// Une tâche de claude.ai réduite à ce que l'écran montre : ni jeton, ni identifiant de connecteur, la consigne coupée à 4 000 caractères.
function slimTrigger(item) {
  const state = item.derived_state && typeof item.derived_state === 'object' ? item.derived_state : {};
  const last = item.last_run && typeof item.last_run === 'object' ? item.last_run : null;
  const pick = (value) => (typeof value === 'string' ? value.slice(0, 400) : null);
  return {
    id: item.id,
    name: pick(item.name),
    created_kind: pick(item.created_kind),
    prompt: typeof (state.prompt ?? item.prompt) === 'string' ? (state.prompt ?? item.prompt).slice(0, 4000) : null,
    model: pick(state.model || item.model),
    cron_expression: pick(item.cron_expression),
    run_once_at: pick(item.run_once_at),
    next_run_at: pick(item.next_run_at),
    enabled: typeof item.enabled === 'boolean' ? item.enabled : null,
    ended_reason: pick(item.ended_reason),
    suspension_reason: pick(item.suspension_reason),
    connectors: (Array.isArray(item.mcp_connections) ? item.mcp_connections : []).map((connection) => pick(connection?.name)).filter(Boolean).slice(0, 30),
    persistent_session_id: pick(item.persistent_session_id),
    persist_session: typeof item.persist_session === 'boolean' ? item.persist_session : null,
    permission_mode: pick(state.permission_mode),
    created_surface: pick(item.created_surface),
    created_via: pick(item.created_via),
    last_run: last ? {status: pick(last.status), fired_at: pick(last.fired_at), finished_at: pick(last.finished_at), session_id: pick(last.session_id), failure_reason: pick(last.failure_reason)} : null,
    created_at: pick(item.created_at)
  };
}

// Une liste lue page par page : la première page la commence, une page suivante la continue si son curseur est celui attendu.
// Elle ne vaut inventaire (les identifiants de toute la liste) que lue jusqu'au bout, sans filtre.
function scheduleKnown(session, input, ids, more, next) {
  const file = join(schedulesDir, String(session).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120) || 'session');
  const cursor = typeof input?.cursor === 'string' && input.cursor ? input.cursor : null;
  const unfiltered = (input?.enabled ?? null) === null && (input?.recurring ?? null) === null;
  let chain = cursor === null ? {ids: [], whole: unfiltered} : null;
  if (cursor !== null) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved?.next === cursor && Date.now() - saved.at < SCHEDULE_CHAIN_MS && Array.isArray(saved.ids)) chain = {ids: saved.ids, whole: saved.whole === true && unfiltered};
    } catch {}
  }
  if (!chain) return null;
  const all = [...new Set([...chain.ids, ...ids])];
  try {
    if (more && next && all.length <= 500) {
      mkdirSync(schedulesDir, {recursive: true});
      writeFileSync(file, JSON.stringify({at: Date.now(), next, ids: all, whole: chain.whole}));
    } else {
      unlinkSync(file);
    }
  } catch {}
  return !more && chain.whole && all.length <= 500 ? all : null;
}

// Les tâches planifiées de claude.ai lues dans la réponse de list_triggers (une page) ou de get_trigger (une tâche).
function cloudSchedules(event) {
  let items = null;
  let more = false;
  let next = null;
  for (const value of jsonParts(event.tool_response)) {
    if (Array.isArray(value.data)) {
      items = value.data;
      more = value.has_more === true;
      next = typeof value.next_cursor === 'string' && value.next_cursor ? value.next_cursor : null;
      break;
    }
    const one = value.trigger && typeof value.trigger === 'object' ? value.trigger : value;
    if (typeof one.id === 'string' && one.id.startsWith('trig_')) {
      items = [one];
      break;
    }
  }
  if (!items) return null;
  const listed = items.filter((item) => item && typeof item === 'object' && typeof item.id === 'string');
  const known = /list_triggers$/i.test(String(event.tool_name)) ? scheduleKnown(event.session_id, event.tool_input, listed.map((item) => item.id), more, next) : null;
  const owner = process.env.CLAUDE_CODE_ACCOUNT_UUID || listed.find((item) => typeof item.creator?.account_uuid === 'string')?.creator.account_uuid || 'claude';
  return {source: 'cloud', owner, tasks: listed.slice(0, 200).map(slimTrigger), known};
}

// Les champs simples d'une en-tête YAML : « clé: valeur », entre guillemets ou non, ou en bloc (« > », « | ») sur les lignes en retrait qui suivent.
function frontmatter(text) {
  const fields = {};
  const lines = text.split(/\r?\n/);
  for (let at = 0; at < lines.length; at++) {
    const match = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[at]);
    if (!match) continue;
    let value = match[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (at + 1 < lines.length && /^([ \t]|$)/.test(lines[at + 1])) block.push(lines[++at].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n').trim();
    } else if (value.length > 1 && /^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }
  return fields;
}

// Les tâches locales de Claude Desktop : un dossier par tâche, sa consigne dans SKILL.md, son nom et sa description en tête.
function desktopSchedules() {
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'scheduled-tasks');
  let names;
  try {
    names = readdirSync(dir, {withFileTypes: true}).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch {
    return null;
  }
  const tasks = [];
  for (const name of names.slice(0, 100)) {
    try {
      const file = join(dir, name, 'SKILL.md');
      // Un lien symbolique ne se suit pas : seule la consigne écrite là part, jamais un fichier d'ailleurs.
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 65_536) continue;
      const text = readFileSync(file, 'utf8');
      const head = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
      const meta = head ? frontmatter(head[1]) : {};
      const prompt = (head ? head[2] : text).trim();
      tasks.push({id: name, name: (meta.name || name).slice(0, 300), description: meta.description ? meta.description.slice(0, 600) : null, prompt: prompt ? prompt.slice(0, 400) : null});
    } catch {}
  }
  // Plus de cent dossiers : la liste n'est pas lue en entier, rien ne part de la base.
  return {source: 'desktop', owner: (hostname() || 'poste').replace(/[^\w.:@-]/g, '-').slice(0, 120), tasks, known: names.length <= 100 ? names : null};
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

// Le délai que Claude Code laisse à ce hook avant un outil, en secondes, lu dans les réglages qui le déclarent (60 par défaut).
function preToolBudget() {
  let budget = 0;
  const files = [join(homedir(), '.claude', 'settings.json')];
  if (process.env.CLAUDE_PROJECT_DIR) files.push(join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'settings.json'));
  for (const file of files) {
    try {
      for (const entry of JSON.parse(readFileSync(file, 'utf8'))?.hooks?.PreToolUse ?? []) {
        for (const hook of entry?.hooks ?? []) {
          if (String(hook?.command ?? '').includes('agent-manager')) budget = Math.max(budget, Number(hook.timeout) || 60);
        }
      }
    } catch {}
  }
  return budget || 60;
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

// La copie des fichiers modifiés pendant un tour, lancée détachée à sa fin.
const copyAt = process.argv.indexOf('copy');
if (copyAt > 1) {
  try {
    const listFile = process.argv[copyAt + 1];
    const session = process.argv[copyAt + 2];
    const lines = readFileSync(listFile, 'utf8').split('\n');
    unlinkSync(listFile);
    // Un fichier modifié dix fois ne part qu'une fois, avec le dossier de sa dernière modification.
    const edits = new Map();
    for (const line of lines) {
      const item = parse(line);
      if (typeof item?.path !== 'string') continue;
      edits.delete(item.path);
      edits.set(item.path, typeof item.cwd === 'string' ? item.cwd : '');
    }
    const sentFile = copyFile(session, '.sent');
    let sent = {};
    try { sent = JSON.parse(readFileSync(sentFile, 'utf8')) ?? {}; } catch {}
    for (const [path, cwd] of [...edits].slice(-40)) {
      if (SECRET_FILE.test(path.replace(/^.*[\/\\]/, ''))) continue;
      let bytes = null;
      try {
        const stat = statSync(path);
        if (stat.isFile() && stat.size <= COPY_MAX) bytes = readFileSync(path);
      } catch {}
      if (!bytes) continue;
      // Inchangé depuis sa dernière copie : rien ne repart.
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sent[path] === sha) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((done) => setTimeout(done, attempt * 2000));
        try {
          const response = await fetch(base + '/api/ingest/copy?session=' + encodeURIComponent(session) + '&path=' + encodeURIComponent(path) + '&cwd=' + encodeURIComponent(cwd), {
            method: 'POST',
            headers: {'content-type': 'application/octet-stream', authorization: 'Bearer ' + token},
            body: bytes,
            signal: AbortSignal.timeout(60_000)
          });
          if (response.status === 200) sent[path] = sha;
          if (response.status < 500 && response.status !== 429) break;
        } catch {}
      }
    }
    writeFileSync(sentFile, JSON.stringify(sent));
  } catch {}
  process.exit(0);
}

// L'envoi d'un relevé de la batterie Claude, lancé détaché par la barre d'état : elle n'attend pas le réseau.
const quotaAt = process.argv.indexOf('quota');
if (quotaAt > 1) {
  try {
    await fetch(base + '/api/ingest/quota', {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer ' + token},
      body: process.argv[quotaAt + 1],
      signal: AbortSignal.timeout(10_000)
    });
  } catch {}
  process.exit(0);
}

// La barre d'état de Claude Code (lot 2026-10-31-batterie-claude) : Claude Code y passe les limites de l'abonnement
// (`rate_limits` : la part utilisée de la fenêtre de cinq heures et de la semaine, l'heure de recharge). Le script les
// affiche en une ligne et les envoie, au plus une fois par demi-minute quand elles bougent, sinon toutes les dix minutes.
if (process.argv.includes('statusline')) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let data = null;
  try { data = JSON.parse(input); } catch {}
  const lines = [];
  // Une barre d'état déjà en place continue de s'afficher : AGENT_MANAGER_STATUSLINE est sa commande, lancée avec la même entrée.
  const before = process.env.AGENT_MANAGER_STATUSLINE;
  if (before) {
    try {
      const shown = execSync(before, {input, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true}).trimEnd();
      if (shown) lines.push(shown);
    } catch {}
  }
  const limits = data && typeof data.rate_limits === 'object' && data.rate_limits ? data.rate_limits : null;
  const five = limits && typeof limits.five_hour?.used_percentage === 'number' && typeof limits.five_hour?.resets_at === 'number' ? limits.five_hour : null;
  const week = limits && typeof limits.seven_day?.used_percentage === 'number' && typeof limits.seven_day?.resets_at === 'number' ? limits.seven_day : null;
  const left = (window) => Math.max(0, Math.round(100 - window.used_percentage)) + ' %';
  const hour = (window) => new Date(window.resets_at * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  const parts = [];
  if (five) parts.push('Batterie 5 h ' + left(five) + ' (recharge ' + hour(five) + ')');
  if (week) parts.push('semaine ' + left(week));
  if (parts.length) lines.push(parts.join(' · '));
  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
  if (url && token && (five || week)) {
    try {
      const stateFile = join(tmpdir(), 'agent-manager-quota.json');
      const signature = JSON.stringify([five?.used_percentage ?? null, five?.resets_at ?? null, week?.used_percentage ?? null, week?.resets_at ?? null]);
      let last = null;
      try { last = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {}
      const since = Date.now() - (Number(last?.at) || 0);
      if (last?.signature !== signature ? since > 30_000 : since > 600_000) {
        writeFileSync(stateFile, JSON.stringify({signature, at: Date.now()}));
        const body = JSON.stringify({rate_limits: {five_hour: five ?? undefined, seven_day: week ?? undefined}, session_id: data?.session_id, host: hostname(), hook_version: VERSION});
        spawn(process.execPath, [fileURLToPath(import.meta.url), 'quota', body], {detached: true, stdio: 'ignore', env: process.env, windowsHide: true}).unref();
      }
    } catch {}
  }
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
    if (!denied) {
      if (event.tool_name === 'Agent' || event.tool_name === 'Task') noteName(event.session_id, event.tool_input);
      // Une question part dès qu'elle est posée : un fil de projet ou une session cloud la montre sans
      // PermissionRequest, et l'écran ne saurait rien avant la réponse (lot 2026-10-31-ce-qui-bloque).
      if (event.tool_name === 'AskUserQuestion') {
        delete event.transcript_path;
        delete event.agent_transcript_path;
        // Un fil de projet n'aura pas de PermissionRequest : l'application y ouvre la validation à distance, et l'on attend
        // ici la réponse du cockpit ou de l'e-mail, sans dépasser le délai de ce hook ; sans réponse, la carte s'affiche
        // dans le fil (lot 2026-10-31-repondre-au-fil).
        const project = process.env.CLAUDE_CODE_PROJECTS_SESSION === '1';
        if (project) event.origin = 'project';
        const reply = await call('/api/ingest', event, project ? 4000 : 2000);
        const approval = reply?.control?.approval;
        if (project && approval) {
          const deadline = Date.now() + Math.min(Number(reply.control.wait) || 0, preToolBudget() - 8) * 1000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const state = await call('/api/control/approvals/' + encodeURIComponent(approval), undefined, 3000);
            if (state?.state === 'allow' && state.answers && typeof state.answers === 'object') {
              answer({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Répondu depuis Agent Manager.', updatedInput: {...event.tool_input, answers: state.answers}}});
              break;
            }
            if (state?.state === 'deny') {
              answer({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Refusé depuis Agent Manager' + (state.message ? ' : ' + state.message : '.')}});
              break;
            }
            if (state?.state === 'expired' || state?.state === 'allow') break;
          }
        }
      }
      process.exit(0);
    }
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
  // Une liste de tâches planifiées de claude.ai part réduite à ce que l'écran montre ; sa dernière page, avec les identifiants de toute la liste.
  if (hook === 'PostToolUse' && SCHEDULE_TOOL.test(String(event.tool_name ?? '')) && 'tool_response' in event) {
    const schedules = cloudSchedules(event);
    if (schedules) event.agent_manager_schedules = schedules;
  }
  // Une étape ajoutée au plan n'a son identifiant que dans la réponse : il part seul, pour que ses mises à jour la retrouvent.
  if (hook === 'PostToolUse' && event.tool_name === 'TaskCreate' && 'tool_response' in event) {
    const step = createdStepId(event.tool_response);
    if (step) event.agent_manager_step_id = step;
  }
  delete event.tool_response;

  // Un fichier écrit ou modifié, ou une image ou un PDF lu, par la session ou un sous-agent : son chemin attend la fin du tour pour partir en copie.
  if (hook === 'PostToolUse' && (WRITERS.has(event.tool_name) || event.tool_name === 'Read') && event.session_id) {
    const file = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
    if (typeof file === 'string' && file && (event.tool_name !== 'Read' || READ_COPY.test(file))) {
      try {
        mkdirSync(copyDir, {recursive: true});
        appendFileSync(copyFile(event.session_id, '.edits'), JSON.stringify({path: resolve(event.cwd || process.cwd(), file), cwd: event.cwd ?? ''}) + '\n');
      } catch {}
    }
  }

  if (hook === 'SubagentStart' && event.session_id) {
    const asked = claimName(event.session_id, event.agent_type);
    if (asked) event.agent_manager_task = asked;
  }

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
    for (const dir of [clockDir, policyDir, waitDir, uploadDir, copyDir, namesDir, schedulesDir]) {
      try {
        for (const name of readdirSync(dir)) {
          const file = join(dir, name);
          if (Date.now() - statSync(file).mtimeMs > 86_400_000) unlinkSync(file);
        }
      } catch {}
    }
    // Les tâches locales de Claude Desktop, relevées à chaque démarrage d'une session du poste.
    const local = desktopSchedules();
    if (local) event.agent_manager_schedules = local;
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

  // À la fin d'un tour, la dernière version de chaque fichier modifié, si l'organisation le permet : un processus détaché l'envoie.
  if (reply && (hook === 'Stop' || hook === 'SessionEnd') && !event.agent_id && event.session_id) {
    try {
      const edits = copyFile(event.session_id, '.edits');
      const listFile = edits + '.' + process.pid + '-' + Date.now();
      renameSync(edits, listFile);
      if ((await policyFor(event.session_id))?.outputs === true) {
        spawn(process.execPath, [fileURLToPath(import.meta.url), 'copy', listFile, event.session_id], {detached: true, stdio: 'ignore', env: process.env}).unref();
      } else {
        unlinkSync(listFile);
      }
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
