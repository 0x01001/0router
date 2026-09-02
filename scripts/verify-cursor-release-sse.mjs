#!/usr/bin/env node

import fs from "node:fs";

const file = process.argv[2];

if (!file) {
  console.error("Usage: node scripts/verify-cursor-release-sse.mjs <sse-file>");
  process.exit(2);
}

const raw = fs.readFileSync(file, "utf8");
let content = "";
let toolCall = false;
let explicitError = null;

for (const line of raw.split(/\r?\n/)) {
  if (!line.startsWith("data:")) continue;

  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") continue;

  try {
    const event = JSON.parse(payload);
    if (event.error) explicitError = event.error;

    for (const choice of event.choices || []) {
      const delta = choice.delta || {};
      if (typeof delta.content === "string") content += delta.content;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        toolCall = true;
      }
    }
  } catch {
    // Ignore non-JSON SSE metadata lines; only parsed output counts as success.
  }
}

if (!content.trim() && !toolCall) {
  const reason = explicitError
    ? JSON.stringify(explicitError)
    : "stream ended without non-whitespace content/tool call";
  console.error(`[release] Cursor content probe failed: ${reason}`);
  process.exit(1);
}

console.log(
  `[release] Cursor content probe passed (${Buffer.byteLength(content, "utf8")} content bytes)`,
);
