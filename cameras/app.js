/* contrailCameras dashboard: shared data layer + index and camera pages. */
(function () {
  const CFG = window.CC_CONFIG || {};
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- registry loading ----------
  async function loadSnapshot() {
    const [cams, meta] = await Promise.all([
      fetch("data/cameras.json").then((r) => r.json()),
      fetch("data/meta.json").then((r) => r.json()).catch(() => ({})),
    ]);
    const rows = cams.rows.map((r) => Object.fromEntries(cams.columns.map((c, i) => [c, r[i] == null ? "" : String(r[i])])));
    return { rows, source: "snapshot", label: meta.snapshot_label || meta.built_utc || "snapshot", meta };
  }

  async function loadLiveSheet() {
    const url = `https://docs.google.com/spreadsheets/d/${CFG.sheetId}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(CFG.sheetTab || "cameras")}`;
    const txt = await fetch(url, { credentials: "omit" }).then((r) => r.text());
    const a = txt.indexOf("("), b = txt.lastIndexOf(")");
    if (a < 0 || b < 0) throw new Error("not a gviz response");
    const j = JSON.parse(txt.slice(a + 1, b));
    if (j.status === "error") throw new Error(JSON.stringify(j.errors));
    const cols = j.table.cols.map((c) => (c.label || c.id || "").trim());
    const rows = [];
    for (const r of j.table.rows) {
      const o = {};
      cols.forEach((c, i) => {
        const cell = r.c[i];
        let v = "";
        if (cell && cell.v != null) v = (typeof cell.v === "number") ? String(cell.v) : (cell.f != null ? cell.f : String(cell.v));
        if (c) o[c] = v;
      });
      if (o.camera_id) rows.push(o);
    }
    if (!rows.length) throw new Error("empty sheet");
    return { rows, source: "live", label: "live sheet, loaded " + new Date().toISOString().slice(11, 19) + " UTC" };
  }

  async function loadRegistry() {
    const snap = await loadSnapshot();
    if (CFG.liveSheet && CFG.sheetId) {
      try {
        const live = await loadLiveSheet();
        // keep build-time fields (stored-image flags) from the snapshot
        const extra = new Map(snap.rows.map((r) => [r.camera_id, r]));
        for (const r of live.rows) {
          const s = extra.get(r.camera_id);
          if (s) for (const k of Object.keys(s)) if (k.startsWith("_")) r[k] = s[k];
        }
        live.meta = snap.meta;
        return live;
      } catch (e) {
        console.warn("live sheet unavailable, using snapshot:", e.message);
      }
    }
    return snap;
  }

  // ---------- derived fields ----------
  const NETWORKS = [
    [/alertcalifornia\.org/, "ALERTCalifornia"], [/infoclimat\.fr/, "Infoclimat"], [/almeso\.net/, "almeso"],
    [/meteoalentejo\.pt/, "MeteoAlentejo"], [/weatherstem\.com/, "WeatherSTEM"], [/youtube\.com|youtu\.be/, "YouTube"],
    [/nps\.gov/, "NPS"], [/alertwest|alertwildfire/, "AlertWest"], [/fripon/, "FRIPON"],
  ];
  function network(r) {
    const u = (r.image_url || "").toLowerCase();
    for (const [re, name] of NETWORKS) if (re.test(u)) return name;
    const src = r.source_tab || "";
    if (/spaceweatherlive/i.test(src)) return "SpaceWeatherLive";
    if (/boston/i.test(src)) return "Boston";
    try { return new URL(r.image_url).hostname.replace(/^www\./, ""); } catch { return "other"; }
  }
  function statusClass(r) {
    const s = (r.status || "").trim().toLowerCase();
    if (!s) return "unknown";
    if (s.startsWith("in progress")) return "in";
    return s.split(/[\s(:]/)[0];
  }
  function cadence(r) {
    const n = parseFloat(r.frame_interval_s);
    const sc = statusClass(r);
    if (sc === "slow") return "slow";
    if (!isNaN(n)) return n <= 75 ? "fast" : "slow";
    return "unknown";
  }
  const isYouTube = (r) => /youtube\.com|youtu\.be/i.test(r.image_url || "");
  const hasCoords = (r) => !isNaN(parseFloat(r.lat)) && !isNaN(parseFloat(r.lon));
  const badge = (r) => `<span class="badge ${esc(statusClass(r))}" title="${esc(r.status)}">${esc((r.status || "?").split(" (")[0])}</span>`;

  // current-image URL with cache-buster; http sources go through a fetch proxy
  // because this page is served over https (browsers block http images).
  function liveUrl(url, useProxy) {
    const bust = (url.includes("?") ? "&" : "?") + "_=" + Date.now();
    if (useProxy || /^http:\/\//i.test(url)) {
      return "https://images.weserv.nl/?url=" + encodeURIComponent(url.replace(/^https?:\/\//i, "") + bust) ;
    }
    return url + bust;
  }
  const embedUrl = (url) => {
    try {
      const u = new URL(url);
      const v = u.searchParams.get("v") || (u.hostname === "youtu.be" ? u.pathname.slice(1) : "");
      return v ? `https://www.youtube.com/embed/${v}?autoplay=0&mute=1` : url;
    } catch { return url; }
  };

  function setSourceBadge(reg) {
    const el = $("#srcbadge");
    if (!el) return;
    el.textContent = reg.source === "live" ? "registry: " + reg.label : "registry: snapshot (" + reg.label + ")";
    el.classList.toggle("live", reg.source === "live");
    el.title = reg.source === "live" ? "Read directly from the Google Sheet" : "Live sheet not readable from here; showing the snapshot built into the site";
  }

  // ---------- index page ----------
  async function initIndex() {
    const reg = await loadRegistry();
    setSourceBadge(reg);
    const rows = reg.rows;
    rows.forEach((r, i) => { r._i = i; r._net = network(r); r._sc = statusClass(r); r._cad = cadence(r); });

    const fill = (sel, vals) => { const s = $(sel); for (const v of vals) { const o = document.createElement("option"); o.value = v; o.textContent = v; s.appendChild(o); } };
    const uniq = (f) => [...new Set(rows.map(f).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
    fill("#f-status", uniq((r) => r._sc));
    fill("#f-region", uniq((r) => r.region));
    fill("#f-net", uniq((r) => r._net));

    const map = L.map("map", { preferCanvas: true }).setView([38, -30], 3);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "&copy; OpenStreetMap" }).addTo(map);
    const col = { candidate: "#2a9d3f", slow: "#d9a400", dead: "#d62828", stale: "#c2571f", needs: "#5a7aa6", intermittent: "#8a4fbf", in: "#1f5fbf", calibrated: "#0f8a8a", skip: "#8a8f98" };
    const layer = L.layerGroup().addTo(map);
    const leg = L.control({ position: "bottomleft" });
    leg.onAdd = () => { const d = L.DomUtil.create("div", "legend"); d.innerHTML = Object.entries(col).map(([k, c]) => `<span class="dot" style="background:${c}"></span>${k}`).join("<br>"); return d; };
    leg.addTo(map);

    const state = { q: "", status: "", region: "", net: "", fast: false, sort: "name", dir: 1 };
    const readHash = () => { const p = new URLSearchParams(location.hash.slice(1)); for (const k of ["q", "status", "region", "net", "sort"]) if (p.has(k)) state[k] = p.get(k); state.fast = p.get("fast") === "1"; if (p.has("dir")) state.dir = +p.get("dir") || 1; };
    const writeHash = () => { const p = new URLSearchParams(); for (const k of ["q", "status", "region", "net", "sort"]) if (state[k]) p.set(k, state[k]); if (state.fast) p.set("fast", "1"); if (state.dir < 0) p.set("dir", "-1"); history.replaceState(null, "", "#" + p.toString()); };
    readHash();
    $("#f-q").value = state.q; $("#f-status").value = state.status; $("#f-region").value = state.region; $("#f-net").value = state.net; $("#f-fast").checked = state.fast;

    function filtered() {
      const q = state.q.trim().toLowerCase();
      return rows.filter((r) => (!state.status || r._sc === state.status) && (!state.region || r.region === state.region) && (!state.net || r._net === state.net)
        && (!state.fast || r._cad === "fast")
        && (!q || [r.name, r.camera_id, r.country, r.view_description, r.notes, r.image_url].some((v) => (v || "").toLowerCase().includes(q))));
    }
    const num = (v) => { const n = parseFloat(v); return isNaN(n) ? -Infinity : n; };
    function sorted(list) {
      const k = state.sort, d = state.dir;
      const key = { name: (r) => (r.name || "").toLowerCase(), net: (r) => r._net.toLowerCase(), region: (r) => r.region || "", status: (r) => r._sc,
        interval: (r) => num(r.frame_interval_s), size: (r) => num(r.image_width) * num(r.image_height), verified: (r) => r.last_verified || "", captured: (r) => r._last_capture || "" }[k] || ((r) => r._i);
      return list.slice().sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * d; });
    }
    function render() {
      const list = sorted(filtered());
      $("#count").textContent = `${list.length} of ${rows.length} cameras`;
      const tb = $("#cams tbody");
      tb.innerHTML = list.map((r) => `<tr data-i="${r._i}"><td><a href="camera.html?id=${esc(r.camera_id)}">${esc(r.name || r.camera_id)}</a><br><span class="muted"><code>${esc(r.camera_id)}</code></span></td>
        <td>${esc(r._net)}</td><td>${esc(r.region)}${r.country && r.country !== r.region ? " · " + esc(r.country) : ""}</td><td>${badge(r)}</td>
        <td class="num">${esc(r.frame_interval_s)}</td><td class="num">${r.image_width ? esc(r.image_width) + "×" + esc(r.image_height) : ""}</td><td class="num" title="last frame saved by the hourly capture job">${r._last_capture ? esc(r._last_capture.slice(4, 6) + "-" + r._last_capture.slice(6, 8) + " " + r._last_capture.slice(9, 11) + ":" + r._last_capture.slice(11, 13)) : ""}</td></tr>`).join("");
      layer.clearLayers();
      const pts = [];
      for (const r of list) {
        if (!hasCoords(r)) continue;
        const ll = [parseFloat(r.lat), parseFloat(r.lon)];
        pts.push(ll);
        const c = col[r._sc] || "#8a8f98";
        L.circleMarker(ll, { radius: 6, color: c, fillColor: c, fillOpacity: 0.85, weight: 1 })
          .bindPopup(() => `<b>${esc(r.name)}</b><br><code>${esc(r.camera_id)}</code> ${badge(r)}<br>${esc(r._net)} · ${esc(r.frame_interval_s || "?")} s · ${esc(r.region)}<br>
            <a href="camera.html?id=${esc(r.camera_id)}">open camera page</a>` + (r._sc !== "dead" && !isYouTube(r) ? `<br><img src="${esc(liveUrl(r.image_url))}" referrerpolicy="no-referrer" loading="lazy">` : ""), { maxWidth: 320 })
          .addTo(layer);
      }
      writeHash();
    }
    const on = (sel, ev, f) => $(sel).addEventListener(ev, f);
    on("#f-q", "input", (e) => { state.q = e.target.value; render(); });
    on("#f-status", "change", (e) => { state.status = e.target.value; render(); });
    on("#f-region", "change", (e) => { state.region = e.target.value; render(); });
    on("#f-net", "change", (e) => { state.net = e.target.value; render(); });
    on("#f-fast", "change", (e) => { state.fast = e.target.checked; render(); });
    on("#f-fit", "click", () => { const pts = filtered().filter(hasCoords).map((r) => [parseFloat(r.lat), parseFloat(r.lon)]); if (pts.length) map.fitBounds(pts, { padding: [20, 20] }); });
    for (const th of document.querySelectorAll("#cams th[data-sort]")) th.addEventListener("click", () => { const k = th.dataset.sort; if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = 1; } render(); });
    window.addEventListener("hashchange", () => { readHash(); $("#f-q").value = state.q; $("#f-status").value = state.status; $("#f-region").value = state.region; $("#f-net").value = state.net; $("#f-fast").checked = state.fast; render(); });
    render();
    const pts = rows.filter(hasCoords).map((r) => [parseFloat(r.lat), parseFloat(r.lon)]);
    if (pts.length) map.fitBounds(pts, { padding: [20, 20] });
  }

  // ---------- camera page ----------
  async function initCamera() {
    const id = new URLSearchParams(location.search).get("id");
    const [reg, images] = await Promise.all([loadRegistry(), fetch("data/images.json").then((r) => r.json()).catch(() => ({}))]);
    setSourceBadge(reg);
    const rows = reg.rows;
    const i = rows.findIndex((r) => r.camera_id === id);
    if (i < 0) { $("#page").innerHTML = `<p>No camera with id <code>${esc(id)}</code> in the registry. <a href="index.html">Back to the list</a>.</p>`; return; }
    const r = rows[i];
    document.title = `${r.name || r.camera_id} · contrailCameras`;
    const prev = rows[(i - 1 + rows.length) % rows.length], next = rows[(i + 1) % rows.length];
    const net = network(r), sc = statusClass(r), cad = cadence(r);
    const row = (k, v, raw) => (v || v === 0) ? `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>` : "";
    const link = (u, label) => u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(label || u)}</a>` : "";
    const sheetRowLink = CFG.sheetUrl ? `<a href="${esc(CFG.sheetUrl)}#gid=0&range=A${i + 2}" target="_blank" rel="noopener" title="row ${i + 2} of the cameras tab">sheet row ${i + 2}</a>` : "";
    const yt = isYouTube(r);
    const stored = images[r.camera_id] || [];
    const driveFolder = r.drive_url ? link(r.drive_url, "Drive folder") : (CFG.driveRootUrl ? `<span class="muted">no Drive folder yet (created when the camera is promoted)</span>` : "");
    const cadLabel = { fast: "fast (≥ 1 image/min)", slow: "slow (< 1 image/min)", unknown: "not measured" }[cad];

    $("#page").innerHTML = `
      <div class="titlebar"><h2>${esc(r.name || r.camera_id)}</h2> ${badge(r)} <span class="muted">${esc(net)} · ${esc(r.region)}${r.country && r.country !== r.region ? " · " + esc(r.country) : ""}</span>
        <span class="nav"><a href="camera.html?id=${esc(prev.camera_id)}" title="${esc(prev.name)}">← prev</a> · <a href="index.html">list</a> · <a href="camera.html?id=${esc(next.camera_id)}" title="${esc(next.name)}">next →</a></span></div>
      <div class="cols">
        <div>
          <div class="card current">
            <h3>Current image</h3>
            <div id="imgbox"></div>
            <div class="toolbar"><button id="btn-refresh">refresh</button>
              <label><input type="checkbox" id="auto" checked> auto-refresh every ${CFG.refreshSeconds || 60} s</label>
              <span id="loaded"></span> ${link(r.image_url, "open source URL")} ${link(r.page_url, "camera page")}</div>
          </div>
          <div class="card"><h3>Stored images (${esc(r._n_stored || stored.length)}${r._n_stored && +r._n_stored > stored.length ? `, newest ${stored.length} shown` : ""})</h3>
            <p class="muted">Frames saved for calibration in <code>Worldscope/cameras/${esc(r.camera_id)}/images/</code> ${driveFolder}${reg.meta && reg.meta.built_utc ? ` · site built ${esc(reg.meta.built_utc.slice(0, 16).replace("T", " "))} UTC` : ""}</p>
            ${stored.length ? `<div class="montage">${stored.map((im) => `<figure><a href="${im.drive_file_id ? `https://drive.google.com/file/d/${esc(im.drive_file_id)}/view` : esc(im.thumb)}" target="_blank" rel="noopener"><img src="${esc(im.thumb)}" loading="lazy" alt="${esc(im.file)}"></a>
              <figcaption>${esc(im.utc ? im.utc.replace("T", " ").replace("Z", " UTC") : im.file)} · ${im.w}×${im.h}</figcaption></figure>`).join("")}</div>` : `<p class="muted">No stored frames yet.</p>`}
          </div>
        </div>
        <div>
          <div class="card"><h3>Identity</h3><dl>
            ${row("camera_id", `<code>${esc(r.camera_id)}</code> ${sheetRowLink}`, true)}${row("network", net)}${row("source", r.source_tab)}
            ${row("status", `${badge(r)}${(r.status || "").includes(" (") ? " " + esc(r.status) : ""}`, true)}${row("last verified", r.last_verified)}
            ${row("image URL", link(r.image_url), true)}${row("page", link(r.page_url), true)}</dl></div>
          <div class="card"><h3>Where</h3><div id="minimap"></div><dl style="margin-top:8px">
            ${row("lat, lon", hasCoords(r) ? `${esc(r.lat)}, ${esc(r.lon)} <a href="https://www.google.com/maps?q=${esc(r.lat)},${esc(r.lon)}" target="_blank" rel="noopener">map</a>` : "", true)}
            ${row("altitude", r.alt_m ? r.alt_m + " m" : "")}${row("accuracy", r.location_accuracy)}${row("location source", r.location_source)}</dl></div>
          <div class="card"><h3>Camera</h3><dl>
            ${row("type", r.camera_type)}${row("frame size", r.image_width ? `${r.image_width} × ${r.image_height}` : "")}${row("model", r.camera_model)}
            ${row("est. HFOV", r.est_hfov_deg ? r.est_hfov_deg + "°" : "")}${row("heading / tilt", r.heading_deg ? `${r.heading_deg}° / ${r.tilt_deg || "?"}°` : "")}${row("pointing source", r.pointing_source)}
            ${row("sky fraction", r.sky_fraction)}${row("view", r.view_description)}</dl></div>
          <div class="card"><h3>Timing</h3><dl>
            ${row("cadence", cadLabel)}${row("frame interval", r.frame_interval_s ? r.frame_interval_s + " s" : "")}${row("how measured", r.frame_interval_source)}
            ${row("last hourly capture", r._last_capture ? r._last_capture.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3 $4:$5 UTC") : "")}</dl></div>
          <div class="card"><h3>Calibration</h3><dl>
            ${row("folder", driveFolder, true)}${row("constraints.json", r._constraints ? (r._constraints_file_id ? link(`https://drive.google.com/file/d/${r._constraints_file_id}/view`, "seeded (open)") : "seeded") : "not yet", true)}
            ${row("calibration.json", r._calibration ? "present" : "not yet")}${row("tier", r._calibration ? "" : "T0 (metadata only)")}</dl></div>
          ${r.notes ? `<div class="card"><h3>Notes</h3><div class="notes">${esc(r.notes)}</div></div>` : ""}
        </div>
      </div>`;

    // current image
    const box = $("#imgbox");
    let timer = null, useProxy = false;
    function showImage() {
      if (yt) { box.innerHTML = `<iframe src="${esc(embedUrl(r.image_url))}" allowfullscreen></iframe>`; return; }
      if (!r.image_url) { box.innerHTML = `<div class="err">No image URL in the registry.</div>`; return; }
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.alt = r.name || r.camera_id;
      img.onload = () => { box.replaceChildren(img); $("#loaded").textContent = `loaded ${new Date().toISOString().slice(11, 19)} UTC · ${img.naturalWidth}×${img.naturalHeight}${useProxy ? " · via proxy" : ""}`; };
      img.onerror = () => {
        if (!useProxy) { useProxy = true; img.src = liveUrl(r.image_url, true); return; }
        box.innerHTML = `<div class="err">Could not load the current image (blocked, offline, or the camera is down).<br>${link(r.image_url, "Try the source URL directly")}</div>`;
        $("#loaded").textContent = "";
      };
      img.src = liveUrl(r.image_url, useProxy);
    }
    function schedule() { clearInterval(timer); if ($("#auto").checked && !yt && sc !== "dead") timer = setInterval(showImage, 1000 * (CFG.refreshSeconds || 60)); }
    $("#btn-refresh").addEventListener("click", showImage);
    $("#auto").addEventListener("change", schedule);
    showImage(); schedule();

    // minimap
    if (hasCoords(r)) {
      const ll = [parseFloat(r.lat), parseFloat(r.lon)];
      const m = L.map("minimap", { zoomControl: false, attributionControl: false }).setView(ll, 9);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(m);
      L.circleMarker(ll, { radius: 7, color: "#d62828", fillColor: "#d62828", fillOpacity: 0.9 }).addTo(m);
      if (r.heading_deg) {
        const az = parseFloat(r.heading_deg) * Math.PI / 180, dl = 0.12;
        L.polyline([ll, [ll[0] + dl * Math.cos(az), ll[1] + dl * Math.sin(az) / Math.cos(ll[0] * Math.PI / 180)]], { color: "#d62828", weight: 2, dashArray: "4 4" }).addTo(m);
      }
    } else {
      $("#minimap").innerHTML = `<p class="muted">No coordinates yet (status: ${esc(r.status)}).</p>`;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const page = document.body.dataset.page;
    const run = page === "index" ? initIndex : page === "camera" ? initCamera : null;
    if (run) run().catch((e) => { console.error(e); const el = $("#page") || $("#count"); if (el) el.textContent = "Failed to load the registry: " + e.message; });
  });
})();
