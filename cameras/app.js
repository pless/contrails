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
    [/nps\.gov/, "NPS"], [/alertwest|alertwildfire/, "AlertWest"], [/fripon/, "FRIPON"], [/allsky\.tv|allsky7\.net/, "AllSky7"], [/idokep\.hu/, "Időkép"],
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
  // sources whose terms do not allow showing their images on other sites: link to them instead
  const NO_EMBED = /(^|\.)(idokep\.hu|viaero\.com|skylinewebcams\.com|hazcams\.com|myairportcams\.com)$/i;   // their terms do not allow showing the images
  const noEmbed = (r) => { try { return NO_EMBED.test(new URL(r.image_url).hostname); } catch { return false; } };
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

  // ---------- verification evidence (data/verify.json, written by tools/build_verify_page.py) ----------
  const loadVerify = () => fetch("data/verify.json").then((r) => r.json()).catch(() => ({ summary: {}, cameras: [] }));
  const sg = (v, d) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d == null ? 2 : d);
  const frameTime = (s) => String(s || "").replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3 $4:$5 UTC");
  const VKEY = [["#eb2828", "published pointing"], ["#46d246", "after the skyline fit"], ["#ffeb00", "what the image shows"]].map(([c, t]) => `<span class="key"><i style="background:${c}"></i>${t}</span>`).join("");
  const vpic = (o, w, h, alt) => o.img ? `<a href="${esc(o.img)}" target="_blank" rel="noopener"><img src="${esc(o.img)}" width="${w}" height="${h}" loading="lazy" alt="${esc(alt)}"></a>` : "";
  function skyText(s) {
    const fix = s.d_pan == null ? `flat horizon, so tilt and roll only: tilt ${sg(s.d_tilt)}°, roll ${sg(s.roll)}°`
      : `pan ${sg(s.d_pan)}°, tilt ${sg(s.d_tilt)}°, roll ${sg(s.roll)}°, focal ×${s.focal.toFixed(3)}`;
    return `<b>${fix}</b><br><span class="muted">skyline misfit ${s.misfit_published_px} → ${s.misfit_fitted_px} px · ${s.frames} frames · relief ${s.relief_deg}° · skyline ${s.skyline_km} km away<br>published pan ${s.pan}°, tilt ${sg(s.tilt)}°, field of view ${s.hfov}° · ${esc(frameTime(s.frame))}</span>`;
  }
  function sunText(s) {
    return `<b class="sun-${esc(s.verdict)}">${esc(s.verdict)}</b>: sun found ${sg(s.d_az)}° in azimuth, ${sg(s.d_el)}° in elevation from the published pointing <span class="muted">(median of ${s.frames} frame${s.frames === 1 ? "" : "s"})</span>`
      + (s.fit_frames ? `<br>after the skyline fit: ${sg(s.fit_d_az)}°, ${sg(s.fit_d_el)}° <span class="muted">(${s.fit_frames} frame${s.fit_frames === 1 ? "" : "s"} at that pointing, published there: ${sg(s.pub_d_az)}°, ${sg(s.pub_d_el)}°)</span>` : "")
      + `<br><span class="muted">${esc(frameTime(s.frame))}</span>`;
  }

  async function initVerify() {
    const [reg, ver] = await Promise.all([loadRegistry(), loadVerify()]);
    setSourceBadge(reg);
    const byId = new Map(reg.rows.map((r) => [r.camera_id, r]));
    const cams = ver.cameras.map((c) => {
      const r = byId.get(c.camera_id) || { status: c.status };
      return Object.assign(c, { _r: r, _sc: statusClass(r), _ev: c.skyline && c.sun ? "both" : c.skyline ? "skyline" : "sun" });
    });
    const s = ver.summary, n = (f) => cams.filter(f).length;
    $("#vsummary").innerHTML = `
      <p><b>${n((c) => c._sc === "calibrated")} ALERTCalifornia cameras are marked calibrated on the evidence below</b>, ${n((c) => c._sc === "in")} are held as in progress and ${n((c) => c._sc !== "calibrated" && c._sc !== "in")} have evidence that does not settle it.
        ${s.skyline_good} cameras have a clean terrain-skyline fit (of ${s.skyline_cameras_tried} tried) and ${s.sun.consistent} pass the sun check (${s.sun.offset} fail it, ${s.sun.unclear} are unclear).</p>
      <p>What it says about the published pointing: pan is good (within 1° of the skyline fit for ${s.pan_within_1deg_pct}% of the ${s.skyline_pan_pinned} cameras whose skyline pins it), tilt is not (within 1° for ${s.tilt_within_1deg_pct}%, largest ${s.tilt_abs_max.toFixed(1)}°), roll is not published (typically ${s.roll_abs_median.toFixed(1)}°) and the focal length is about ${Math.round((s.focal_median - 1) * 100)}% longer than the published field of view implies.
        The two checks are independent and agree: on the ${s.sun_and_skyline} cameras with both, the skyline fit moves the predicted sun closer to the sun in the picture (typical miss ${s.sun_el_abs_median_published}° → ${s.sun_el_abs_median_fitted}° in elevation, ${s.sun_az_abs_median_published}° → ${s.sun_az_abs_median_fitted}° in azimuth).</p>
      <p class="vkey">${VKEY}</p>
      <p class="muted"><b>Skyline picture</b>: a band of one stored frame. The lines are the terrain skyline computed from an elevation model at the camera's position, drawn with the published pointing and with the fitted one; the dots are the skyline found in the stored frames. Green on the dots means the fit explains the picture, and the gap from red to green is the correction.
        <b>Sun picture</b>: part of a frame with the sun in it. The crosses are where each pointing puts the sun at the time the frame was taken; the ring is the centre of the saturated sun.
        Click a picture for the full size. Numbers: <a href="data/verify.csv">verify.csv</a> · skyline run ${esc((s.skyline_run_utc || "").slice(0, 16).replace("T", " "))} UTC · ${s.sun_frames_checked} sun frames checked, the last at ${esc(frameTime(s.sun_last_frame))} · <a href="about.html#verification">how it works</a></p>`;

    const sel = $("#v-status");
    for (const v of [...new Set(cams.map((c) => c._sc))].sort()) { const o = document.createElement("option"); o.value = v; o.textContent = v === "in" ? "in progress" : v; sel.appendChild(o); }
    const state = { q: "", ev: "", sun: "", status: "", sort: "name" };
    const ctl = { q: "#v-q", ev: "#v-ev", sun: "#v-sun", status: "#v-status", sort: "#v-sort" };
    const readHash = () => { const p = new URLSearchParams(location.hash.slice(1)); for (const k of Object.keys(state)) { state[k] = p.get(k) || (k === "sort" ? "name" : ""); $(ctl[k]).value = state[k]; } };
    readHash();
    const abs = (v) => (v == null ? -1 : Math.abs(v));
    const key = {
      name: (c) => 0, tilt: (c) => -abs(c.skyline && c.skyline.d_tilt), pan: (c) => -abs(c.skyline && c.skyline.d_pan), roll: (c) => -abs(c.skyline && c.skyline.roll),
      misfit: (c) => -(c.skyline ? c.skyline.misfit_fitted_px : -1), sun: (c) => -(c.sun ? Math.hypot(c.sun.d_az, c.sun.d_el) : -1),
    };
    function render() {
      const q = state.q.trim().toLowerCase(), k = key[state.sort] || key.name;
      const list = cams.filter((c) => (!state.ev || c._ev === state.ev) && (!state.sun || (c.sun && c.sun.verdict === state.sun)) && (!state.status || c._sc === state.status)
        && (!q || c.name.toLowerCase().includes(q) || c.camera_id.includes(q))).sort((a, b) => k(a) - k(b));   // the list arrives sorted by name; the sort is stable
      $("#v-count").textContent = `${list.length} of ${cams.length} cameras`;
      $("#vtable tbody").innerHTML = list.map((c) => `<tr>
        <td class="vcam"><a href="camera.html?id=${esc(c.camera_id)}">${esc(c.name)}</a><br><span class="muted"><code>${esc(c.camera_id)}</code></span><br>${badge(c._r)}<div class="muted vstatus">${esc(c._r.status || "")}</div></td>
        <td class="vsky">${c.skyline ? vpic(c.skyline, 960, 270, "skyline fit, " + c.name) + `<div>${skyText(c.skyline)}</div>` : `<span class="muted">no clean skyline fit</span>`}</td>
        <td class="vsun">${c.sun ? vpic(c.sun, 480, 270, "sun check, " + c.name) + `<div>${sunText(c.sun)}</div>` : `<span class="muted">sun not measured yet</span>`}</td></tr>`).join("");
      const p = new URLSearchParams();
      for (const k2 of Object.keys(state)) if (state[k2] && !(k2 === "sort" && state[k2] === "name")) p.set(k2, state[k2]);
      history.replaceState(null, "", "#" + p.toString());
    }
    for (const k of Object.keys(state)) $(ctl[k]).addEventListener(k === "q" ? "input" : "change", (e) => { state[k] = e.target.value; render(); });
    window.addEventListener("hashchange", () => { readHash(); render(); });
    render();
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
            <a href="camera.html?id=${esc(r.camera_id)}">open camera page</a>` + (r._sc !== "dead" && !isYouTube(r) && !noEmbed(r) ? `<br><img src="${esc(liveUrl(r.image_url))}" referrerpolicy="no-referrer" loading="lazy">` : ""), { maxWidth: 320 })
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
    const [reg, images, ver] = await Promise.all([loadRegistry(), fetch("data/images.json").then((r) => r.json()).catch(() => ({})), loadVerify()]);
    setSourceBadge(reg);
    const rows = reg.rows;
    const v = ver.cameras.find((c) => c.camera_id === id);
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
              <span id="loaded"></span> ${noEmbed(r) ? "" : link(r.image_url, "open source URL")} ${link(r.page_url, "camera page")}</div>
          </div>
          ${v ? `<div class="card verify"><h3>Verification</h3><p class="vkey">${VKEY}<a href="verify.html">all cameras</a></p>
            ${v.skyline ? `<div class="vblock">${vpic(v.skyline, 960, 270, "skyline fit")}<div>Skyline fit: ${skyText(v.skyline)}</div></div>` : ""}
            ${v.sun ? `<div class="vblock vsunblock">${vpic(v.sun, 480, 270, "sun check")}<div>Sun check: ${sunText(v.sun)}</div></div>` : ""}</div>` : ""}
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
            ${row("image URL", noEmbed(r) ? "on the camera page" : link(r.image_url), true)}${row("page", link(r.page_url), true)}</dl></div>
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
            ${row("calibration.json", r._calibration ? "present" : "not yet")}${row("tier", ((r.status || "").match(/^calibrated \((T\d)/) || [])[1] || (r._calibration ? "" : "T0 (metadata only)"))}
            ${row("evidence", v ? "skyline and sun pictures in the Verification card" : "")}</dl></div>
          ${r.notes ? `<div class="card"><h3>Notes</h3><div class="notes">${esc(r.notes)}</div></div>` : ""}
        </div>
      </div>`;

    // current image
    const box = $("#imgbox");
    let timer = null, useProxy = false;
    function showImage() {
      if (yt) { box.innerHTML = `<iframe src="${esc(embedUrl(r.image_url))}" allowfullscreen></iframe>`; return; }
      if (!r.image_url) { box.innerHTML = `<div class="err">No image URL in the registry.</div>`; return; }
      if (noEmbed(r)) { box.innerHTML = `<div class="err">This source does not allow its images to be shown on other sites.<br>${link(r.page_url || r.image_url, "See the current image on the camera's own page")}</div>`; return; }
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
    function schedule() { clearInterval(timer); if ($("#auto").checked && !yt && !noEmbed(r) && sc !== "dead") timer = setInterval(showImage, 1000 * (CFG.refreshSeconds || 60)); }
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
    const run = page === "index" ? initIndex : page === "camera" ? initCamera : page === "verify" ? initVerify : null;
    if (run) run().catch((e) => { console.error(e); const el = $("#page") || $("#count"); if (el) el.textContent = "Failed to load the registry: " + e.message; });
  });
})();
