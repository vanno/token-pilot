#!/usr/bin/env node
import {closeSync, openSync, readSync, statSync} from 'node:fs';

const url = process.env.AGENT_MANAGER_URL;
const token = process.env.AGENT_MANAGER_TOKEN;
if (!url || !token) process.exit(0);

function lastUsage(path) {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    readSync(fd, buffer, 0, length, size - length);
    closeSync(fd);
    const lines = buffer.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const usage = entry?.message?.usage;
      if (entry?.type !== 'assistant' || !usage) continue;
      const tokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      return {tokens, model: entry.message.model};
    }
  } catch {}
  return null;
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const event = JSON.parse(raw);
  if (event.transcript_path && !event.agent_id && event.hook_event_name !== 'SessionEnd') {
    const usage = lastUsage(event.transcript_path);
    if (usage) {
      event.context_tokens = usage.tokens;
      if (usage.model && !event.model) event.model = usage.model;
      const limit = Number(process.env.AGENT_MANAGER_CONTEXT_LIMIT);
      if (limit > 0) event.context_limit = limit;
    }
  }
  delete event.transcript_path;
  await fetch(url.replace(/\/+$/, '') + '/api/ingest', {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer ' + token},
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(4000)
  });
} catch {}
process.exit(0);
