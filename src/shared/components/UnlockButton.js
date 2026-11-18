"use client";

/**
 * UnlockButton — header action shown only while some model is cooldown-locked.
 *
 * A locked model (modelLock_* on a connection) short-circuits every request with
 * 503 without calling upstream, so a provider-side quota reset is never noticed
 * until the lock expires. This lets the user clear the lock immediately.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useNotificationStore } from "@/store/notificationStore";

const POLL_INTERVAL_MS = 30000;

function formatRemaining(until) {
  const ms = new Date(until).getTime() - Date.now();
  if (!(ms > 0)) return "expired";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// One entry per provider+model — clearCooldown clears that lock on every connection.
function groupLocks(models) {
  const map = new Map();
  for (const item of models || []) {
    if (item.status !== "cooldown") continue;
    const key = `${item.provider}:${item.model}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { key, provider: item.provider, model: item.model, until: item.until, lastError: item.lastError, count: 1 });
    } else {
      prev.count += 1;
      if (new Date(item.until) > new Date(prev.until)) prev.until = item.until;
    }
  }
  return [...map.values()];
}

export default function UnlockButton() {
  const [locks, setLocks] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const ref = useRef(null);
  const notify = useNotificationStore();

  const fetchLocks = useCallback(async () => {
    try {
      const res = await fetch("/api/models/availability", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      const next = groupLocks(json.models);
      setLocks(next);
      if (next.length === 0) setOpen(false);
    } catch {
      // silent — retry on next poll
    }
  }, []);

  useEffect(() => {
    // Initial poll deferred out of the effect body (react-hooks/set-state-in-effect).
    const initial = setTimeout(fetchLocks, 0);
    const interval = setInterval(fetchLocks, POLL_INTERVAL_MS);
    window.addEventListener("focus", fetchLocks);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      window.removeEventListener("focus", fetchLocks);
    };
  }, [fetchLocks]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const clearLock = async ({ provider, model }) => {
    const res = await fetch("/api/models/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clearCooldown", provider, model }),
    });
    return res.ok;
  };

  const handleUnlock = async (targets, busyKey) => {
    setBusy(busyKey);
    try {
      const results = await Promise.all(targets.map((t) => clearLock(t).catch(() => false)));
      const failed = results.filter((ok) => !ok).length;
      if (failed === 0) {
        notify.success(targets.length === 1 ? `Unlocked ${targets[0].model}` : `Unlocked ${targets.length} models`);
      } else {
        notify.error(`Failed to unlock ${failed} model(s)`);
      }
      await fetchLocks();
    } finally {
      setBusy(null);
    }
  };

  if (locks.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors text-sm font-medium"
        aria-label="Unlock locked models"
        aria-expanded={open}
      >
        <span className="material-symbols-outlined text-[18px]">lock_open</span>
        <span className="hidden sm:inline">Unlock</span>
        <span className="rounded-full bg-amber-500/20 px-1.5 text-[11px] leading-5">{locks.length}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface shadow-xl z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
            <span className="text-sm font-semibold text-text-main">Locked models</span>
            <button
              onClick={() => handleUnlock(locks, "__all")}
              disabled={busy !== null}
              className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
            >
              {busy === "__all" ? "Unlocking..." : "Unlock all"}
            </button>
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {locks.map((lock) => (
              <li key={lock.key} className="flex items-start gap-2 px-3 py-2 hover:bg-surface-hover/50">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text-main truncate" title={`${lock.provider}/${lock.model}`}>
                    <span className="text-text-muted">{lock.provider}/</span>
                    {lock.model === "__all" ? "all models" : lock.model}
                  </div>
                  <div className="text-xs text-text-muted">
                    {formatRemaining(lock.until)} left
                    {lock.count > 1 ? ` · ${lock.count} accounts` : ""}
                  </div>
                  {lock.lastError && (
                    <div className="text-xs text-text-muted truncate" title={lock.lastError}>
                      {lock.lastError}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleUnlock([lock], lock.key)}
                  disabled={busy !== null}
                  className="shrink-0 px-2 h-7 rounded-md border border-border text-xs font-medium text-text-main hover:bg-primary/10 hover:text-primary disabled:opacity-50"
                >
                  {busy === lock.key ? "..." : "Unlock"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
