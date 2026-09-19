/**
 * Cursor upstream model compatibility settings.
 *
 * Keep model ids here instead of hardcoding them in the executor. Cursor's
 * `default` model is Auto and must remain server-selected; deployments can
 * still override it for compatibility testing.
 */
export const CURSOR_DEFAULT_UPSTREAM_MODEL =
  process.env.CURSOR_DEFAULT_UPSTREAM_MODEL?.trim() || "default";

export const CURSOR_DISABLE_AGENT_SERVICE =
  process.env.CURSOR_DISABLE_AGENT_SERVICE === "1";

export const CURSOR_LEGACY_MODEL_MAP = Object.freeze({
  "claude-3-5-sonnet": "claude-4.5-sonnet",
  "claude-3-5-sonnet-20241022": "claude-4.5-sonnet",
  "claude-3-5-sonnet-20240620": "claude-4.5-sonnet",
  "claude-3-5-haiku": "claude-4.5-haiku",
  "gpt-4o": "gpt-5.2",
  "gpt-4o-mini": "gpt-5.2",
});
