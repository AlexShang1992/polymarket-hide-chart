(() => {
  "use strict";

  function roundSeries(url) {
    const slug = url.pathname.match(/\/event\/([^/]+)\/?$/)?.[1];
    return slug?.match(/^(.+-updown-\d+[mhd])-\d+$/)?.[1];
  }

  window.addEventListener("click", (event) => {
    // Preserve open-in-new-tab, middle-click and browser shortcut behavior.
    if (event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target instanceof Element
      ? event.target.closest("a[href]") : null;
    if (!anchor || anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")) return;

    const destination = new URL(anchor.href, window.location.href);
    const current = new URL(window.location.href);
    const series = roundSeries(current);
    if (!series || destination.origin !== current.origin ||
        roundSeries(destination) !== series) return;

    // Only the left chart's round bar, including its small past-round links
    // and "Go to live" link. Recommendations and trading controls are outside.
    const bar = anchor.closest("div.relative.flex.flex-col");
    if (!bar || !Array.from(bar.querySelectorAll("#price-chart-container"))
      .some((chart) => chart.parentElement?.parentElement === bar)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (destination.href === current.href) {
      window.location.reload();
    } else {
      window.location.assign(destination.href);
    }
  }, true);
})();
