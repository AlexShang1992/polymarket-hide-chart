(() => {
  "use strict";

  const markerClass = "pm-local-round-estimate";
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
      .filter((anchor) => !anchor.closest("#price-chart-container"))
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
    document.getElementById("pm-local-round-result")?.remove();
    const result = state && results.get(state.key);
    const anchor = state?.candidate.anchor;
    let marker = anchor?.querySelector(`.${markerClass}`);
    for (const element of document.querySelectorAll(`.${markerClass}`)) {
      if (!result || element !== marker) element.remove();
    }
    if (!result) return;
    if (!marker) {
      marker = document.createElement("span");
      marker.className = markerClass;
      (anchor.querySelector(":scope > div") || anchor).prepend(marker);
    }
    const signature = `${state.key}:${result.open}:${result.close}`;
    if (marker.dataset.signature === signature) return;
    marker.dataset.signature = signature;
    marker.dataset.direction = result.direction;
    marker.textContent = result.direction === "up" ? "↑" : "↓";
    marker.setAttribute("aria-label", `按价格暂判 ${result.direction.toUpperCase()}，非官方结果`);
    marker.title = `目标价：${result.open}\n结束价：${result.close}\n` +
      "按价格暂判，非官方结算；官方方向出现后自动移除。";
  }

  function remember(key, data) {
    const open = price(data?.openPrice);
    const close = price(data?.closePrice);
    if (open === null || close === null) return false;
    results.set(key, { open, close, direction: close >= open ? "up" : "down" });
    return true;
  }

  // The ended event's server snapshot can already contain both chart prices
  // while the separately cached price API still reports an incomplete window.
  // Parse data only: never execute scripts from the fetched event page.
  function chartSnapshot(html, state) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const stream = Array.from(doc.scripts).map((script) => {
      const match = script.textContent.trim().match(/^self\.__next_f\.push\(([\s\S]*)\);?$/);
      if (!match) return "";
      try {
        const chunk = JSON.parse(match[1]);
        return typeof chunk[1] === "string" ? chunk[1] : "";
      } catch { return ""; }
    }).join("");
    let position = 0;
    while ((position = stream.indexOf('"queryKey":["crypto-prices","price",', position)) !== -1) {
      const start = stream.lastIndexOf('{"dehydratedAt":', position);
      position += 1;
      if (start === -1) continue;
      let depth = 0, quoted = false, escaped = false;
      for (let end = start; end < stream.length; end++) {
        const char = stream[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{" || char === "[") depth++;
        else if ((char === "}" || char === "]") && --depth === 0) {
          try {
            const query = JSON.parse(stream.slice(start, end + 1));
            const key = query.queryKey;
            const params = state.url.searchParams;
            if (key?.[2] === state.current.symbol &&
                Date.parse(key[3]) === state.candidate.info.start * 1000 &&
                key[4] === params.get("variant") &&
                Date.parse(key[5]) === state.candidate.info.end * 1000 &&
                Boolean(key[6]) === (params.get("twapEnabled") === "true") &&
                (!key[6] || Number(key[7]) === Number(params.get("twapLookbackSeconds"))) &&
                query.state?.status === "success" &&
                query.state.dataUpdatedAt >= state.candidate.info.end * 1000 &&
                price(query.state.data?.openPrice) !== null &&
                price(query.state.data?.closePrice) !== null) return query.state.data;
          } catch { /* Ignore incomplete or unrelated serialized records. */ }
          break;
        }
      }
    }
    return null;
  }

  async function read(url, type) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      return response.ok ? await response[type]() : null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sync() {
    scheduled = false;
    const state = context();
    render(state);
    if (!state || document.hidden || results.has(state.key) || pendingKey ||
        Date.now() < nextRequestAt) return;
    pendingKey = state.key;
    try {
      try {
        const data = await read(state.url, "json");
        if (data?.completed === true && data.incomplete === false && remember(state.key, data)) return;
      } catch { /* Try the ended event's own chart snapshot next. */ }
      const html = await read(state.candidate.url, "text");
      if (html) {
        const data = chartSnapshot(html, state);
        if (data) remember(state.key, data);
      }
    } catch {
      // Never invent a direction when neither price source is ready.
    } finally {
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
      if (changes.some((change) => !change.target.closest?.(`.${markerClass}`))) schedule();
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
