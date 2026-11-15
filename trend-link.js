(() => {
  "use strict";

  const toolbarId = "pm-local-trend-toolbar";
  const destination = "https://www.binance.com/zh-CN/trade/BTC_USDT?type=spot";
  let pending = false;

  window.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element
      ? event.target.closest("#pm-local-trend-toolbar > a.pm-local-trend-link")
      : null;
    if (!link) return;

    // Open synchronously during the user's click, before site/router handlers.
    event.preventDefault();
    event.stopImmediatePropagation();
    window.open(destination, "_blank", "noopener,noreferrer");
  }, true);

  function syncButton() {
    pending = false;
    const existing = document.getElementById(toolbarId);
    if (!/\/event\/btc-updown-\d+[mhd]-\d+\/?$/i.test(window.location.pathname)) {
      existing?.remove();
      return;
    }

    // The chart's grandparent also holds the round navigation. Append after
    // that navigation, directly above the order book, without resizing the plot.
    const chart = Array.from(document.querySelectorAll("#price-chart-container"))
      .find((element) => element.getClientRects().length > 0);
    const bar = chart?.parentElement?.parentElement;
    if (!bar?.matches("div.relative.flex.flex-col")) return;
    if (existing?.parentElement === bar) return;
    existing?.remove();

    const toolbar = document.createElement("div");
    toolbar.id = toolbarId;
    const link = document.createElement("a");
    link.className = "pm-local-trend-link";
    link.textContent = "趋势";
    link.href = destination;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    toolbar.append(link);
    bar.append(toolbar);
  }

  function scheduleSync() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(syncButton);
  }

  function start() {
    new MutationObserver(scheduleSync).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("popstate", scheduleSync);
    syncButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
