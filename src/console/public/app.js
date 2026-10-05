"use strict";

// The console page. Everything shown comes from the read-only JSON API. Data is only ever put
// on the page as text nodes (see h), never parsed as HTML.
(() => {
  const PAGE_SIZE = 100;
  const FILTER_NAMES = ["q", "category", "country", "locality", "cuisine"];
  const OSM_ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString();
  const itemUrl = (d) => "/api/item/" + encodeURIComponent(d);

  /** Builds an element. String children become text nodes; attributes with no value are skipped. */
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      node.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const th = (text, cls) => h("th", { scope: "col", class: cls }, text);
  const td = (content, cls, colspan) => h("td", { class: cls, colspan }, content);

  function makeTable(head, rows) {
    return h(
      "table",
      null,
      h("thead", null, h("tr", null, head.map((x) => (Array.isArray(x) ? th(x[0], x[1]) : th(x))))),
      h("tbody", null, rows.map((cells) => h("tr", null, cells))),
    );
  }

  async function getJSON(path) {
    const res = await fetch(path, { headers: { Accept: "application/json" } });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON; the status line below says what went wrong.
    }
    if (!res.ok) throw new Error((body && body.error) || res.status + " " + res.statusText);
    return body;
  }

  const showError = (container, err) =>
    container.replaceChildren(h("p", { class: "error", role: "alert" }, err.message));

  const detailLink = (d, text) => h("a", { href: itemUrl(d), target: "_blank", rel: "noopener" }, text);

  // Overview

  function stat(label, value) {
    return h("div", { class: "stat" }, h("div", { class: "num" }, value), h("div", { class: "label" }, label));
  }

  function renderLastRun(lastRun) {
    if (lastRun === null) return h("p", { class: "muted" }, "No publish runs recorded yet.");
    return h(
      "div",
      null,
      h("p", null, "Run ", h("code", null, lastRun.runId)),
      makeTable(
        ["Relay", ["OK", "num"], ["Failed", "num"]],
        lastRun.relays.map((r) => [
          td(r.relay),
          td(fmt(r.ok), "num"),
          td(fmt(r.failed), r.failed > 0 ? "num bad" : "num"),
        ]),
      ),
    );
  }

  function renderCoverage(coverage) {
    const fields = Object.entries(coverage);
    if (fields.length === 0) return h("p", { class: "muted" }, "No live items.");
    return makeTable(
      ["Tag", ["Coverage", "num"], h("span", { class: "visually-hidden" }, "Bar")],
      fields.map(([field, pct]) => {
        const fill = h("span");
        fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
        return [td(h("code", null, field)), td(pct.toFixed(1) + "%", "num"), td(h("div", { class: "bar" }, fill))];
      }),
    );
  }

  async function loadOverview() {
    const stats = $("overview-stats");
    try {
      const o = await getJSON("/api/overview");
      stats.replaceChildren(stat("Live items", fmt(o.live)), stat("Deleted items", fmt(o.deleted)));
      $("overview-run").replaceChildren(renderLastRun(o.lastRun));
      $("overview-coverage").replaceChildren(renderCoverage(o.coverage));
    } catch (err) {
      showError(stats, err);
    }
  }

  /** Up to 20 values, then how many more there are. */
  const listed = (ds) => ds.slice(0, 20).join(", ") + (ds.length > 20 ? " and " + (ds.length - 20) + " more" : "");

  function renderRelays(results) {
    const names = Object.keys(results);
    const rows = names.map((name) => {
      const r = results[name];
      if (r.error !== undefined) return [td(name), td(r.error, "bad", 6)];
      const count = (list) => td(fmt(list.length), list.length > 0 ? "num bad" : "num");
      return [td(name), td(fmt(r.onRelay), "num"), td(fmt(r.inState), "num"), count(r.missing), count(r.extra), count(r.stale), td(r.extraCheck)];
    });
    const lists = [];
    for (const name of names) {
      const r = results[name];
      for (const [label, ds] of [["missing", r.missing], ["extra", r.extra], ["stale", r.stale]]) {
        if (ds && ds.length > 0) {
          lists.push(
            h("details", null, h("summary", null, name + ": " + label + " (" + fmt(ds.length) + ")"), h("p", { class: "mono" }, listed(ds))),
          );
        }
      }
    }
    return h(
      "div",
      null,
      h("div", { class: "scroll" }, makeTable(["Relay", ["On relay", "num"], ["In state", "num"], ["Missing", "num"], ["Extra", "num"], ["Stale", "num"], "Extra check"], rows)),
      lists,
    );
  }

  async function checkRelays() {
    const button = $("relays-button");
    const status = $("relays-status");
    const out = $("relays-result");
    button.disabled = true;
    status.textContent = "Reading the relays. This can take a few seconds.";
    out.replaceChildren();
    try {
      out.replaceChildren(renderRelays(await getJSON("/api/relays")));
      status.textContent = "Checked at " + new Date().toLocaleTimeString() + ".";
    } catch (err) {
      status.textContent = "";
      showError(out, err);
    } finally {
      button.disabled = false;
    }
  }

  // Table

  const tableState = { offset: 0, total: 0, seq: 0 };

  function currentFilters() {
    const form = $("filters");
    const out = {};
    for (const name of FILTER_NAMES) {
      const value = form.elements[name].value.trim();
      if (value !== "") out[name] = value;
    }
    return out;
  }

  function applyFilter(name, value) {
    $("filters").elements[name].value = value;
    tableState.offset = 0;
    loadTable();
  }

  function itemRow(item) {
    const f = item.fields;
    const filterCell = (name) => {
      const value = f[name];
      if (value === undefined || value === "") return td("");
      const button = h("button", { type: "button", class: "link" }, value);
      button.addEventListener("click", () => applyFilter(name, value));
      return td(button);
    };
    return [
      td(f.name || item.d),
      filterCell("category"),
      filterCell("locality"),
      filterCell("country"),
      filterCell("cuisine"),
      td(detailLink(item.d, h("code", null, item.d))),
    ];
  }

  function renderRange(shown) {
    const { offset, total } = tableState;
    $("table-range").textContent =
      total === 0 ? "No items match." : "showing " + fmt(offset + 1) + "–" + fmt(offset + shown) + " of " + fmt(total);
    $("table-prev").disabled = offset === 0;
    $("table-next").disabled = offset + shown >= total;
  }

  async function loadTable() {
    const seq = ++tableState.seq;
    const params = new URLSearchParams(currentFilters());
    params.set("offset", String(tableState.offset));
    params.set("limit", String(PAGE_SIZE));
    try {
      const data = await getJSON("/api/items?" + params.toString());
      if (seq !== tableState.seq) return; // a newer request has taken over
      tableState.total = data.total;
      document.querySelector("#items-table tbody").replaceChildren(...data.items.map((item) => h("tr", null, itemRow(item))));
      renderRange(data.items.length);
    } catch (err) {
      if (seq !== tableState.seq) return;
      document.querySelector("#items-table tbody").replaceChildren();
      $("table-range").textContent = "Could not load items: " + err.message;
      $("table-prev").disabled = true;
      $("table-next").disabled = true;
    }
  }

  function setUpTable() {
    const form = $("filters");
    let timer = null;
    const reload = () => {
      tableState.offset = 0;
      loadTable();
    };
    form.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(reload, 250);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      reload();
    });
    $("filters-clear").addEventListener("click", () => {
      form.reset();
      reload();
    });
    $("table-prev").addEventListener("click", () => {
      tableState.offset = Math.max(0, tableState.offset - PAGE_SIZE);
      loadTable();
    });
    $("table-next").addEventListener("click", () => {
      tableState.offset += PAGE_SIZE;
      loadTable();
    });
    loadTable();
  }

  // Map

  const localities = new Map();

  /** Fills in the locality line of an open popup; the points list does not carry it. */
  async function fillLocality(d, target, layer) {
    if (!localities.has(d)) {
      try {
        const item = await getJSON(itemUrl(d));
        const tag = item.tags.find((t) => t[0] === "locality");
        localities.set(d, tag === undefined ? "" : tag[1]);
      } catch {
        target.textContent = "Locality could not be loaded.";
        return;
      }
    }
    const locality = localities.get(d);
    target.textContent = locality === "" ? "No locality recorded" : "Locality: " + locality;
    const popup = layer.getPopup();
    if (popup) popup.update();
  }

  function popupFor(point, layer) {
    const d = point[0];
    const locality = h("div", { class: "popup-line muted" }, "Loading locality.");
    const node = h(
      "div",
      { class: "popup" },
      h("strong", null, point[3] || d),
      h("div", { class: "popup-line" }, point[4] === "" ? "No category" : "Category: " + point[4]),
      locality,
      h("div", { class: "popup-line" }, detailLink(d, "Open item JSON")),
    );
    fillLocality(d, locality, layer);
    return node;
  }

  async function loadMap() {
    const status = $("map-status");
    if (typeof L === "undefined" || typeof L.markerClusterGroup !== "function") {
      status.className = "error";
      status.textContent = "The map libraries did not load from unpkg.com, so the map is not shown. The other sections still work.";
      return;
    }
    const map = L.map("map-canvas", { preferCanvas: true }).setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: OSM_ATTRIBUTION,
    }).addTo(map);

    let points;
    try {
      points = await getJSON("/api/points");
    } catch (err) {
      status.className = "error";
      status.textContent = "Could not load places: " + err.message;
      return;
    }
    const style = getComputedStyle(document.documentElement);
    const fill = style.getPropertyValue("--marker").trim() || "#1d6b4b";
    const edge = style.getPropertyValue("--marker-edge").trim() || "#ffffff";
    const cluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false });
    const markers = points.map((point) => {
      const marker = L.circleMarker([point[1], point[2]], { radius: 6, weight: 1.5, color: edge, fillColor: fill, fillOpacity: 0.85 });
      marker.bindPopup((layer) => popupFor(point, layer), { maxWidth: 280 });
      return marker;
    });
    cluster.addLayers(markers);
    map.addLayer(cluster);
    if (points.length > 0) map.fitBounds(L.latLngBounds(points.map((p) => [p[1], p[2]])).pad(0.1));
    status.textContent = fmt(points.length) + " places on the map.";
  }

  // Diff

  const DIFF_CLASSES = [
    ["created", "New", "in the cache, not live yet"],
    ["changed", "Changed", "live, but the cache builds different tags"],
    ["unchanged", "Unchanged", "same tags as the live item"],
    ["gone", "Gone", "live, but not in the cache or no longer in scope"],
  ];

  function exampleTable(kind, rows) {
    const withFields = kind === "changed";
    return makeTable(
      ["Item", "Name", "Category", "Locality", ...(withFields ? ["Changed tags"] : [])],
      rows.map((e) => [
        // A new item is not live yet, so it has no JSON to open.
        td(kind === "created" ? h("code", null, e.d) : detailLink(e.d, h("code", null, e.d))),
        td(e.name || ""),
        td(e.category || ""),
        td(e.locality || ""),
        ...(withFields ? [td((e.changedFields || []).join(", "))] : []),
      ]),
    );
  }

  function renderDiff(diff) {
    const out = [
      h("p", null, "Latest cache: ", h("code", null, diff.cache), "."),
      h("div", { class: "stats" }, DIFF_CLASSES.map(([key, label]) => stat(label, fmt(diff[key])))),
      h("ul", { class: "hint" }, DIFF_CLASSES.map(([, label, meaning]) => h("li", null, label + ": " + meaning + "."))),
    ];
    for (const [kind, label] of DIFF_CLASSES) {
      if (kind === "unchanged") continue;
      const rows = diff.examples[kind];
      if (rows.length === 0) continue;
      const more = diff[kind] > rows.length ? " (first " + rows.length + " of " + fmt(diff[kind]) + ")" : "";
      out.push(h("details", null, h("summary", null, label + " examples" + more), h("div", { class: "scroll" }, exampleTable(kind, rows))));
    }
    return out;
  }

  async function loadDiff() {
    const body = $("diff-body");
    try {
      body.replaceChildren(...renderDiff(await getJSON("/api/diff")));
    } catch (err) {
      showError(body, err);
    }
  }

  // Runs

  function renderRuns(runs) {
    if (runs.length === 0) return h("p", { class: "muted" }, "Nothing has been published yet.");
    const failures = runs.filter((r) => r.failed > 0);
    const summary =
      failures.length === 0
        ? h("p", null, "No failed events recorded.")
        : h(
            "div",
            { class: "error" },
            h("p", null, "Failed events:"),
            h("ul", null, failures.map((r) => h("li", null, r.runId + " on " + r.relay + ": " + fmt(r.failed) + " failed"))),
          );
    let previous = null;
    const rows = [...runs].reverse().map((r) => {
      const first = r.runId !== previous;
      previous = r.runId;
      return [
        td(first ? h("code", null, r.runId) : ""),
        td(r.relay),
        td(fmt(r.ok), "num"),
        td(fmt(r.failed), r.failed > 0 ? "num bad" : "num"),
      ];
    });
    return h("div", null, summary, h("div", { class: "scroll" }, makeTable(["Run", "Relay", ["OK", "num"], ["Failed", "num"]], rows)));
  }

  async function loadRuns() {
    const body = $("runs-body");
    try {
      body.replaceChildren(renderRuns(await getJSON("/api/runs")));
    } catch (err) {
      showError(body, err);
    }
  }

  // Start

  $("relays-button").addEventListener("click", checkRelays);
  setUpTable();
  loadOverview();
  loadMap();
  loadDiff();
  loadRuns();
})();
