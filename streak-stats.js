(() => {
  "use strict";

  const panelId = "pm-local-streak-stats";
  const cacheKey = "pm-local-streak-history-v1";
  const windows = [["2小时", 7200], ["6小时", 21600], ["24小时", 86400]];
  let active = null;
  let pending = false;
  let scheduled = false;

  function positive(value) {
    if ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value))) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function summarize(rows, slot, duration, seconds) {
    const summary = { up: 0, down: 0, missing: 0, provisional: 0, known: 0 };
    let lastDirection = null;
    let run = 0;
    // Iterate expected slots, so a missing round always breaks a run. Never
    // include slot itself: it is the currently running round.
    for (let start = slot - seconds; start < slot; start += duration) {
      const row = rows.get(start);
      if (!row || !["up", "down"].includes(row.direction)) {
        summary.missing++;
        lastDirection = null;
        run = 0;
        continue;
      }
      summary.known++;
      if (row.provisional) summary.provisional++;
      run = lastDirection === row.direction ? run + 1 : 1;
      lastDirection = row.direction;
      summary[row.direction] = Math.max(summary[row.direction], run);
    }
    return summary;
  }

  function render(state) {
    const toolbar = document.getElementById("pm-local-trend-toolbar");
    let panel = document.getElementById(panelId);
    if (!toolbar || !state) { panel?.remove(); return; }
    if (!panel) {
      panel = document.createElement("div");
      panel.id = panelId;
      panel.setAttribute("role", "group");
      panel.setAttribute("aria-label", "已结束期次最长连续涨跌统计");
    }
    if (panel.parentElement !== toolbar) toolbar.append(panel);
    const summaries = windows.map(([, seconds]) => summarize(state.rows, state.slot, state.duration, seconds));
    const signature = JSON.stringify([state.key, summaries, state.loading, state.error]);
    if (panel.dataset.signature === signature) return;
    panel.dataset.signature = signature;
    panel.dataset.slot = String(state.slot);
    panel.dataset.periodSeconds = String(state.duration);
    panel.replaceChildren();
    for (const [index, [label, seconds]] of windows.entries()) {
      const summary = summaries[index];
      const group = document.createElement("div");
      group.className = "pm-local-streak-group";
      group.dataset.hours = String(seconds / 3600);
      group.dataset.up = String(summary.up);
      group.dataset.down = String(summary.down);
      const count = (direction) => summary.known ? `${summary.missing ? "≥" : ""}${summary[direction]}` : "—";
      for (const direction of ["up", "down"]) {
        const line = document.createElement("div");
        line.className = "pm-local-streak-line";
        const number = document.createElement("strong");
        number.textContent = count(direction);
        line.append(`${label}连续${direction.toUpperCase()} `, number, " 期");
        group.append(line);
      }
      group.title = (state.loading ? "读取中…\n" : "") + (state.error ? "更新失败，自动重试中。\n" : "") +
        `当前为${state.duration / 60}分钟一期。统计最近${seconds / state.duration}个已结束窗口，` +
        `不含当前运行期。UP／DOWN分别取最长连续期数，范围外不延长。\n` +
        `已知${summary.known}期，缺${summary.missing}期，按价格暂判${summary.provisional}期。` +
        (summary.missing ? "缺期会打断连续，≥表示已知数据的下限。" : "") +
        "官方结果优先；最终价大于或等于目标价暂判UP，否则暂判DOWN。";
      panel.append(group);
    }
  }

  function loadCache(state) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
      if (saved?.series !== state.series || !Number.isFinite(saved.at) ||
          saved.at > Date.now() || Date.now() - saved.at > 86400000 || !Array.isArray(saved.rows)) return;
      for (const [start, row] of saved.rows) {
        if (Number.isInteger(start) && start >= state.slot - 86400 && start < state.slot &&
            start % state.duration === 0 && ["up", "down"].includes(row?.direction) && !row.provisional) {
          state.rows.set(start, { direction: row.direction, provisional: false });
        }
      }
    } catch { /* Historical public result caching is optional. */ }
  }

  function saveCache(state) {
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ series: state.series, at: Date.now(),
        rows: Array.from(state.rows).filter(([, row]) => !row.provisional) }));
    } catch { /* Statistics remain usable without browser storage. */ }
  }

  async function getJSON(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      // Use the current browser's network/proxy settings and same-site APIs.
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  function priceURL(state, start) {
    const url = new URL(state.source.priceUrl);
    url.searchParams.set("eventStartTime", new Date(start * 1000).toISOString().replace(".000Z", "Z"));
    url.searchParams.set("endDate", new Date((start + state.duration) * 1000).toISOString().replace(".000Z", "Z"));
    url.searchParams.sort();
    return url;
  }

  async function fillPrevious(state) {
    const start = state.slot - state.duration;
    if (state.rows.get(start) && !state.rows.get(start).provisional) return;
    // Reuse the existing temporary-arrow calculation when available.
    const saved = state.source.prices.get(priceURL(state, start).href);
    if (positive(saved?.open) !== null && positive(saved?.close) !== null) {
      state.rows.set(start, { direction: saved.close >= saved.open ? "up" : "down", provisional: true });
      render(state);
    }
    if (Date.now() < state.nextPriceAt) return;
    state.nextPriceAt = Date.now() + 5000;
    const previous = await getJSON(priceURL(state, start));
    const open = positive(previous?.openPrice);
    let close = positive(previous?.closePrice);
    if (open === null) return;
    if (close === null) {
      // The new round's opening target is the same timestamp and price stream
      // as the just-ended closing boundary. Never use the new live quote.
      const current = await getJSON(priceURL(state, state.slot));
      close = positive(current?.openPrice);
    }
    if (close !== null && active === state &&
        (!state.rows.has(start) || state.rows.get(start).provisional)) {
      state.rows.set(start, { direction: close >= open ? "up" : "down", provisional: true });
    }
  }

  async function refreshHistory(state) {
    const starts = [];
    for (let start = state.slot - state.duration; start >= state.slot - 86400; start -= state.duration) {
      // Recheck recent results so official publication replaces provisional
      // prices; reuse older confirmed rounds cached for this browser tab.
      if (start >= state.slot - 50 * state.duration || !state.rows.has(start) || state.rows.get(start).provisional) starts.push(start);
    }
    const batches = [];
    for (let i = 0; i < starts.length; i += 50) batches.push(starts.slice(i, i + 50));
    state.nextHistoryAt = Date.now() + 15000;
    let failures = 0;
    // Two read-only requests at a time; the site's limit is 50 slugs/request.
    for (let i = 0; i < batches.length && active === state; i += 2) {
      await Promise.all(batches.slice(i, i + 2).map(async (batch) => {
        const url = new URL("/api/past-results", location.origin);
        url.search = new URLSearchParams({ includeOutcomesBySlug: "true", outcomesOnly: "true" }).toString();
        for (const start of batch) url.searchParams.append("pastEventSlugs", `btc-updown-${state.duration === 300 ? "5m" : "15m"}-${start}`);
        try {
          const data = await getJSON(url);
          const outcomes = data?.data?.outcomesBySlug;
          if (data?.status !== "success" || !outcomes || typeof outcomes !== "object" || Array.isArray(outcomes)) throw new Error("History unavailable");
          if (active !== state) return;
          for (const start of batch) {
            const direction = outcomes[`btc-updown-${state.duration === 300 ? "5m" : "15m"}-${start}`];
            if (["up", "down"].includes(direction)) state.rows.set(start, { direction, provisional: false });
          }
          render(state);
        } catch { failures++; }
      }));
    }
    if (active !== state) return;
    state.error = failures > 0;
    saveCache(state);
  }

  async function refresh() {
    scheduled = false;
    const state = active;
    render(state);
    if (!state || pending || document.hidden) return;
    pending = true;
    try {
      // Start the latest-round price fallback immediately, independently of
      // downloading a day's official history.
      const jobs = [];
      if (Date.now() >= state.nextHistoryAt) jobs.push(refreshHistory(state));
      jobs.push(fillPrevious(state));
      await Promise.allSettled(jobs);
    } finally {
      pending = false;
      if (active === state) {
        state.loading = false;
        render(state);
      } else schedule();
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(refresh);
  }

  // Shared only inside this extension's isolated content-script world.
  globalThis.pmLocalStreaks = {
    update(source) {
      if (!source || source.current.symbol !== "BTC") { active = null; render(null); return; }
      const duration = source.current.end - source.current.start;
      const slot = Math.floor(Date.now() / (duration * 1000)) * duration;
      const params = new URL(source.priceUrl).searchParams;
      const series = [source.current.series, params.get("variant"), params.get("twapEnabled"), params.get("twapLookbackSeconds")].join(":");
      const key = `${series}:${slot}`;
      if (active?.key !== key) {
        active = { key, series, slot, duration, source, rows: new Map(), loading: true,
          error: false, nextHistoryAt: 0, nextPriceAt: 0 };
        loadCache(active);
      } else active.source = source;
      schedule();
    },
  };

  window.addEventListener("popstate", () => {
    active = null;
    render(null);
  });
  new MutationObserver(() => {
    if (active && !/\/event\/btc-updown-(5m|15m)-\d+\/?$/i.test(location.pathname)) {
      active = null;
      render(null);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
