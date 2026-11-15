(() => {
  "use strict";

  const rowId = "pm-local-round-result";
  const results = new Map();
  let pendingKey = null;
  let nextRequestAt = 0;
  let scheduled = false;

  function round(url) {
    const match = url.pathname.match(/\/event\/([a-z0-9]+)-updown-(5m|15m)-(\d+)\/?$/i);
    if (!match) return null;
    const start = Number(match[3]);
    const duration = match[2] === "5m" ? 300 : 900;
    return { symbol: match[1].toUpperCase(), series: `${match[1]}-${match[2]}`,
      start, end: start + duration };
  }

  function context() {
    const current = round(new URL(location.href));
    const chart = Array.from(document.querySelectorAll("#price-chart-container"))
      .find((element) => element.getClientRects().length > 0);
    const bar = chart?.parentElement?.parentElement;
    if (!current || !bar?.matches("div.relative.flex.flex-col")) return null;

    // Match the site's actual query, including its TWAP settings. Never
    // substitute spot prices or infer a price source from the coin alone.
    const template = performance.getEntriesByType("resource").slice().reverse()
      .map((entry) => new URL(entry.name, location.href))
      .find((url) => url.origin === location.origin &&
        url.pathname === "/api/crypto/crypto-price" &&
        url.searchParams.get("symbol") === current.symbol &&
        Date.parse(url.searchParams.get("eventStartTime")) === current.start * 1000);
    if (!template) return null;

    const candidates = Array.from(bar.querySelectorAll("a[href]"))
      .filter((anchor) => !anchor.closest(`#price-chart-container, #${rowId}`))
      .map((anchor) => ({ anchor, url: new URL(anchor.href), info: round(new URL(anchor.href)) }))
      .filter(({ anchor, url, info }) => url.origin === location.origin &&
        info?.series === current.series && info.start <= current.start &&
        info.end * 1000 <= Date.now() &&
        anchor.getClientRects().length > 0 &&
        // Existing native result circles are already clear; keep them intact.
        !Array.from(anchor.classList).some((name) => /^bg-pk-(green|red)-\d+$/.test(name)))
      .sort((a, b) => b.info.start - a.info.start);
    const candidate = candidates[0];
    if (!candidate) return null;

    const url = new URL(template);
    const iso = (seconds) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
    url.searchParams.set("eventStartTime", iso(candidate.info.start));
    url.searchParams.set("endDate", iso(candidate.info.end));
    return { bar, candidate, key: url.href, url, current };
  }

  function price(value) {
    if ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value))) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function render(state) {
    let row = document.getElementById(rowId);
    if (!state) {
      row?.remove();
      return;
    }
    if (!row || row.parentElement !== state.bar) {
      row?.remove();
      row = document.createElement("div");
      row.id = rowId;
      row.setAttribute("aria-live", "polite");
      state.bar.insertBefore(row, state.bar.querySelector(":scope > #pm-local-trend-toolbar"));
    }
    const result = results.get(state.key);
    const signature = `${state.key}:${result?.direction || "pending"}`;
    if (row.dataset.signature === signature) return;

    row.dataset.signature = signature;
    row.dataset.direction = result?.direction || "pending";
    const link = document.createElement("a");
    link.href = state.candidate.url.href;
    const time = (seconds) => new Date(seconds * 1000).toLocaleTimeString("zh-CN", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York",
    });
    const label = document.createElement("span");
    const period = state.candidate.anchor.textContent.trim().replace(/\s+/g, " ") ||
      `${time(state.candidate.info.start)}–${time(state.candidate.info.end)} ET`;
    label.textContent = `${state.candidate.info.start === state.current.start ? "本局" : "上一局"} ` +
      period;
    const direction = document.createElement("strong");
    direction.className = "pm-local-round-direction";
    direction.textContent = result
      ? (result.direction === "up" ? "↑ UP" : "↓ DOWN") : "等待最终价";
    const note = document.createElement("span");
    note.className = "pm-local-round-note";
    note.textContent = result ? "按价格判断" : "";
    link.append(label, direction, note);
    row.replaceChildren(link);
    if (result) {
      row.title = `目标价：${result.open}\n最终价：${result.close}\n` +
        "最终价 ≥ 目标价为 UP，否则为 DOWN。按网站价格判断，非官方结算结果。";
    } else {
      row.title = "该期已结束；网站尚未提供完整最终价，暂不判断方向。";
    }
  }

  async function sync() {
    scheduled = false;
    const state = context();
    render(state);
    if (!state || document.hidden || results.has(state.key) || pendingKey ||
        Date.now() < nextRequestAt) return;
    pendingKey = state.key;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(state.url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) return;
      const data = await response.json();
      const open = price(data.openPrice);
      const close = price(data.closePrice);
      // A live last tick or an incomplete TWAP must never become a result.
      if (data.completed === true && data.incomplete === false && open !== null && close !== null) {
        results.set(state.key, { open, close, direction: close >= open ? "up" : "down" });
      }
    } catch {
      // Leave the explicit waiting state on network errors and retry later.
    } finally {
      clearTimeout(timeout);
      pendingKey = null;
      nextRequestAt = Date.now() + 3000;
      schedule();
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(sync);
  }

  function start() {
    new MutationObserver((changes) => {
      if (changes.some((change) => !change.target.closest?.(`#${rowId}`))) schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", schedule);
    document.addEventListener("visibilitychange", schedule);
    setInterval(schedule, 3000);
    schedule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
