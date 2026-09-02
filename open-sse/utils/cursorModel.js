import {
  CURSOR_DEFAULT_UPSTREAM_MODEL,
  CURSOR_LEGACY_MODEL_MAP,
} from "../config/cursorConstants.js";

/**
 * Strip a provider prefix and normalize legacy Cursor model ids.
 * @param {string} model
 * @returns {string}
 */
export function normalizeCursorModelId(model) {
  const raw = String(model || "").split("/").pop() || "";
  const dateSuffix = raw.match(/^(.+)-(\d{8})$/);
  const withoutDate = dateSuffix ? dateSuffix[1] : raw;
  return CURSOR_LEGACY_MODEL_MAP[raw]
    || CURSOR_LEGACY_MODEL_MAP[withoutDate]
    || withoutDate;
}

/**
 * Resolve the model id sent to Cursor's upstream protobuf service.
 * @param {string} model
 * @returns {string}
 */
export function resolveCursorUpstreamModel(model) {
  const id = normalizeCursorModelId(model);
  return id === "default" || id === "auto"
    ? CURSOR_DEFAULT_UPSTREAM_MODEL
    : id;
}

/**
 * Cursor can place visible output after a redacted </think> marker in its
 * thinking protobuf field for Auto, Composer, and explicit thinking models.
 * @param {string} model
 * @returns {boolean}
 */
export function shouldPromoteThinkingToContent(model) {
  const id = normalizeCursorModelId(model);
  return id === "default"
    || id === "auto"
    || /^composer(?:-|$)/i.test(id)
    || /-thinking(?:-|$)/i.test(id);
}

/**
 * Return only user-visible text after the final redacted thinking block.
 * @param {string} thinking
 * @returns {string}
 */
export function visibleContentFromThinking(thinking) {
  if (!thinking) return "";
  const endTag = "</think>";
  const endIdx = thinking.lastIndexOf(endTag);
  if (endIdx < 0) return "";
  return thinking.slice(endIdx + endTag.length).trimStart();
}
