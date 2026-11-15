(() => {
  "use strict";

  const markerClass = "pm-local-round-estimate";
  const storageKey = "pm-local-round-prices-v1";
  const results = new Map();
  let sourceCache = null;
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
    let template = performance.getEntriesByType("resource").slice().reverse()
      .map((entry) => new URL(entry.name, location.href))
      .find((url) => url.origin === location.origin &&
        url.pathname === "/api/crypto/crypto-price" &&
        url.searchParams.get("symbol") === current.symbol &&
        Date.parse(url.searchParams.get("eventStartTime")) === current.start * 1000 &&
        Date.parse(url.searchParams.get("endDate")) === current.end * 1000);
    if (!template && sourceCache?.start === current.start && sourceCache.end === current.end &&
        sourceCache.symbol === current.symbol) {
      template = sourceCache.url;
    }
    // A hydrated opening price may not trigger any client-side HTTP request.
    if (!template) {
      const query = Array.from(priceQueries(document)).find(({ queryKey: key }) =>
        key?.[2] === current.symbol && Date.parse(key[3]) === current.start * 1000 &&
        Date.parse(key[5]) === current.end * 1000);
      if (query) {
        const key = query.queryKey;
        template = new URL("/api/crypto/crypto-price", location.origin);
        template.search = new URLSearchParams({ symbol: key[2], eventStartTime: key[3],
          variant: key[4], endDate: key[5], twapEnabled: String(Boolean(key[6])),
          ...(key[6] ? { twapLookbackSeconds: String(key[7]) } : {}) }).toString();
      }
    }
    if (!template) return null;
    sourceCache = { start: current.start, end: current.end, symbol: current.symbol, url: template };
    captureEnd(chart, current, template);

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
    url.searchParams.sort();
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
      (anchor.querySelector(":scope > div") || anchor).append(marker);
    }
    const signature = `${state.key}:${result.open}:${result.close}:${Boolean(result.approximate)}`;
    if (marker.dataset.signature === signature) return;
    marker.dataset.signature = signature;
    marker.dataset.direction = result.direction;
    marker.textContent = result.direction === "up" ? "↑" : "↓";
    marker.setAttribute("aria-label", `按价格暂判 ${result.direction.toUpperCase()}，非官方结果`);
    marker.title = `目标价：${result.open}\n结束价：${result.close}\n` +
      (result.approximate ? "当前为价格暂判；原站价格数据更新后自动校正。\n" : "") +
      "按价格暂判，非官方结算；官方方向出现后自动移除。";
  }

  function loadSaved() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
      for (const [key, value] of Object.entries(saved)) {
        if (price(value?.open) === null || price(value?.close) === null ||
            !Number.isFinite(value.at) || value.at > Date.now() ||
            Date.now() - value.at > 86400000) continue;
        const existing = results.get(key);
        if (!existing || (existing.approximate && !value.approximate)) {
          results.set(key, { ...value, direction: value.close >= value.open ? "up" : "down" });
        }
      }
    } catch { /* Public price caching is optional; other site storage is untouched. */ }
  }

  function remember(key, data, approximate = false) {
    const open = price(data?.openPrice);
    const close = price(data?.closePrice);
    if (open === null || close === null) return false;
    if (approximate && results.has(key) && !results.get(key).approximate) return true;
    results.set(key, { open, close, approximate, at: Date.now(), direction: close >= open ? "up" : "down" });
    try {
      const recent = Array.from(results).sort((a, b) => b[1].at - a[1].at).slice(0, 20);
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(recent)));
    } catch { /* Continue without persistence if site storage is unavailable. */ }
    return true;
  }

  function captureEnd(chart, current, template) {
    // Retain the actual ended page's displayed values across a full reload.
    // Never sample an active round or a historical page showing a live feed.
    const elapsed = Date.now() - current.end * 1000;
    if (elapsed < 0 || elapsed > 10000) return;
    const values = Array.from(chart.querySelectorAll("span.text-heading-2xl"))
      .map((element) => (element.querySelector(".pk-animated-label__text") || element).textContent.trim())
      .filter((text) => /^\$[\d,]+\.\d{2}$/.test(text))
      .map((text) => Number(text.replace(/[$,]/g, "")));
    // Rounded equal displays cannot establish the raw direction safely.
    if (values.length !== 2 || values[0] === values[1]) return;
    const url = new URL(template);
    url.searchParams.set("eventStartTime", new Date(current.start * 1000).toISOString().replace(".000Z", "Z"));
    url.searchParams.set("endDate", new Date(current.end * 1000).toISOString().replace(".000Z", "Z"));
    url.searchParams.sort();
    if (results.has(url.href)) return;
    remember(url.href, { openPrice: values[0], closePrice: values[1] }, true);
  }

  // The ended event's server snapshot can already contain both chart prices
  // while the separately cached price API still reports an incomplete window.
  // Parse data only: never execute scripts from the fetched event page.
  function* priceQueries(doc) {
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
            yield query;
          } catch { /* Ignore incomplete or unrelated serialized records. */ }
          break;
        }
      }
    }
  }

  function matchesPriceQuery(query, info, state) {
    const params = state.url.searchParams;
    const key = query.queryKey;
    return key?.[2] === state.current.symbol &&
          Date.parse(key[3]) === info.start * 1000 &&
          key[4] === params.get("variant") &&
          Date.parse(key[5]) === info.end * 1000 &&
          Boolean(key[6]) === (params.get("twapEnabled") === "true") &&
          (!key[6] || Number(key[7]) === Number(params.get("twapLookbackSeconds"))) &&
          query.state?.status === "success" &&
          query.state.dataUpdatedAt >= info.start * 1000;
  }

  function boundaryPrices(state, previousOpen) {
    if (price(previousOpen) === null || state.candidate.info.end !== state.current.start ||
        state.current.start * 1000 > Date.now()) return null;
    const opening = Array.from(priceQueries(document))
      .find((query) => matchesPriceQuery(query, state.current, state));
    let close = price(opening?.state.data?.openPrice);
    if (close === null) {
      // Client-side navigation may leave only the original page's hydration.
      // Read the labelled opening target, never the moving current price.
      const node = state.bar.querySelector("#price-chart-container span.text-heading-2xl");
      const text = (node?.querySelector(".pk-animated-label__text") || node)?.textContent.trim();
      if (!/目标价格|price\s*to\s*beat/i.test(node?.parentElement.textContent || "") ||
          !/^\$[\d,]+\.\d{2}$/.test(text || "")) return null;
      close = price(text.replace(/[$,]/g, ""));
      // A two-decimal display cannot resolve differences within its rounding.
      if (close === null || Math.abs(close - previousOpen) <= 0.005) return null;
    }
    return { openPrice: previousOpen, closePrice: close, provisional: true };
  }

  function chartSnapshot(html, state) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const previous = Array.from(priceQueries(doc))
      .find((query) => matchesPriceQuery(query, state.candidate.info, state));
    if (previous) {
      const query = previous;
      if (query.state.dataUpdatedAt >= state.candidate.info.end * 1000 &&
          price(query.state.data?.openPrice) !== null &&
          price(query.state.data?.closePrice) !== null) return query.state.data;
    }
    // Adjacent windows share the exact boundary timestamp. With the same
    // price stream, variant and TWAP window, the new opening target is also
    // the prior closing boundary price. This is a provisional calculation,
    // never the new window's moving current price or an official outcome.
    return boundaryPrices(state, price(previous?.state.data?.openPrice));
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
    if (!state || document.hidden || (results.has(state.key) && !results.get(state.key).approximate) || pendingKey ||
        Date.now() < nextRequestAt) return;
    pendingKey = state.key;
    try {
      try {
        const data = await read(state.url, "json");
        const provisional = data?.completed !== true || data.incomplete !== false;
        if (remember(state.key, data, provisional)) {
          if (!provisional) return;
          render(context());
        }
        // The prior opening target is already in this compact API response.
        // Do not wait for a historical HTML request to retrieve it a second time.
        const boundary = boundaryPrices(state, price(data?.openPrice));
        if (boundary) {
          remember(state.key, boundary, true);
          return;
        }
      } catch { /* Try the ended event's own chart snapshot next. */ }
      const html = await read(state.candidate.url, "text");
      if (html) {
        const data = chartSnapshot(html, state);
        if (data) remember(state.key, data, data.provisional === true);
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
    loadSaved();
    new MutationObserver((changes) => {
      if (changes.some((change) => !change.target.closest?.(`.${markerClass}`))) schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", schedule);
    window.addEventListener("storage", (event) => {
      if (event.key === storageKey) { loadSaved(); schedule(); }
    });
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
