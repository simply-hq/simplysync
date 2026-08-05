package main

// Self-contained operational dashboard (no external assets/CDNs, CSP-clean).
// It prompts for the admin token, keeps it in sessionStorage, polls <base>/stats
// (derived from its own path — the base is secret), and renders cards + inline
// SVG sparklines for the self-hosted relay dashboard.
const adminPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Relay ops</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: #0e0f13; color: #e7e9ee;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding: 18px 24px; border-bottom: 1px solid #20232c;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .meta { color: #8b90a0; font-size: 12px; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: #3ad29f; display: inline-block; }
  main { padding: 20px 24px; max-width: 1100px; margin: 0 auto; }
  .warn {
    background: #2a1c1c; border: 1px solid #5a2d2d; color: #ffb4b4;
    border-radius: 10px; padding: 10px 14px; margin-bottom: 16px;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .card {
    background: #15171e; border: 1px solid #20232c; border-radius: 12px; padding: 14px 16px;
  }
  .card h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b90a0; font-weight: 600; }
  .card .val { font-size: 22px; font-weight: 650; }
  .card .sub { color: #8b90a0; font-size: 12px; margin-top: 2px; }
  .bar { height: 6px; border-radius: 3px; background: #20232c; margin-top: 8px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: #5b8def; }
  .bar.hot > i { background: #e0653f; }
  section { margin-top: 24px; }
  section h2 { font-size: 13px; color: #8b90a0; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #20232c; }
  th { color: #8b90a0; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .spark { display: block; width: 100%; height: 40px; margin-top: 8px; }
  #login { max-width: 360px; margin: 80px auto; text-align: center; }
  #login input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #30343f; background: #15171e; color: #e7e9ee; }
  #login button { margin-top: 10px; width: 100%; padding: 10px; border-radius: 8px; border: 0; background: #5b8def; color: #fff; font-weight: 600; cursor: pointer; }
  #err { color: #ffb4b4; min-height: 18px; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<div id="login" hidden>
  <h1>Relay ops</h1>
  <p style="color:#8b90a0">Enter the admin token.</p>
  <input id="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password" />
  <button id="go">Open dashboard</button>
  <div id="err"></div>
</div>

<div id="app" hidden>
  <header>
    <span class="dot" id="status"></span>
    <h1>Relay ops</h1>
    <span class="meta" id="host"></span>
    <span class="meta" id="uptime"></span>
    <span class="meta" id="updated" style="margin-left:auto"></span>
  </header>
  <main>
    <div id="warnings"></div>
    <div class="grid" id="cards"></div>

    <section>
      <h2>Trends (last samples)</h2>
      <div class="grid">
        <div class="card"><h3>Stored bytes</h3><svg class="spark" id="sp-stored"></svg></div>
        <div class="card"><h3>DB on disk</h3><svg class="spark" id="sp-db"></svg></div>
        <div class="card"><h3>Disk free</h3><svg class="spark" id="sp-disk"></svg></div>
        <div class="card"><h3>Load (1m)</h3><svg class="spark" id="sp-load"></svg></div>
      </div>
    </section>

    <section>
      <h2>Endpoints</h2>
      <table id="endpoints"><thead><tr><th>Route</th><th class="num">Requests</th></tr></thead><tbody></tbody></table>
    </section>

    <section>
      <h2>Top owners by storage</h2>
      <table id="owners"><thead><tr><th>Owner</th><th class="num">Stored</th></tr></thead><tbody></tbody></table>
    </section>
  </main>
</div>

<script>
const TOKEN_KEY = "sbt_relay_admin_token";
// Stats lives at <this page's path>/stats — the base path is secret, so never
// hardcode it here; derive it from where this page was served.
const STATS_URL = location.pathname.replace(/\/+$/, "") + "/stats";
const $ = (id) => document.getElementById(id);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B","KB","MB","GB","TB"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + " " + u[i];
}
function fmtNum(n) { return (n ?? 0).toLocaleString(); }
function fmtDur(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  return (d?d+"d ":"") + (h?h+"h ":"") + m + "m";
}
function pct(x) { return (x * 100).toFixed(x < 0.1 ? 1 : 0) + "%"; }

function card(title, val, sub, barPct, hot) {
  const bar = barPct != null
    ? '<div class="bar' + (hot ? ' hot' : '') + '"><i style="width:' + Math.min(100, barPct*100).toFixed(1) + '%"></i></div>'
    : '';
  return '<div class="card"><h3>' + title + '</h3><div class="val">' + val +
    '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + bar + '</div>';
}

function sparkline(svg, points, color) {
  if (!points || points.length < 2) { svg.innerHTML = ''; return; }
  const w = svg.clientWidth || 220, h = 40, pad = 2;
  const min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
  const dx = (w - pad*2) / (points.length - 1);
  const path = points.map((p, i) =>
    (i ? 'L' : 'M') + (pad + i*dx).toFixed(1) + ',' +
    (h - pad - ((p - min) / span) * (h - pad*2)).toFixed(1)).join(' ');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.innerHTML = '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>';
}

async function tick() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token) return showLogin();
  let s;
  try {
    const res = await fetch(STATS_URL, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) { sessionStorage.removeItem(TOKEN_KEY); return showLogin('Invalid token.'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    s = await res.json();
  } catch (e) {
    $('status').style.background = '#e0653f';
    return;
  }
  $('status').style.background = '#3ad29f';
  $('login').hidden = true; $('app').hidden = false;

  $('host').textContent = s.system.hostname + ' · ' + s.system.cpus + ' CPU';
  $('uptime').textContent = 'up ' + fmtDur(s.uptimeMs);
  $('updated').textContent = 'updated ' + new Date(s.now).toLocaleTimeString();

  $('warnings').innerHTML = (s.capacity.warnings || [])
    .map(w => '<div class="warn">⚠ ' + escapeHtml(w) + '</div>').join('');

  const cap = s.capacity, sys = s.system, st = s.storage, tr = s.traffic;
  const runway = cap.diskRunwayDays == null ? '—'
    : cap.diskRunwayDays > 3650 ? '10y+' : Math.floor(cap.diskRunwayDays) + ' days';
  $('cards').innerHTML = [
    card('Disk used', pct(sys.disk.usedPct), fmtBytes(sys.disk.used) + ' / ' + fmtBytes(sys.disk.total), sys.disk.usedPct, sys.disk.usedPct > 0.85),
    card('Disk runway', runway, '+' + fmtBytes(cap.dbGrowthBytesPerDay) + '/day'),
    card('Memory', pct(cap.memUsedPct), fmtBytes(sys.mem.used) + ' / ' + fmtBytes(sys.mem.total), cap.memUsedPct, cap.memUsedPct > 0.9),
    card('Load (1m)', sys.load[0].toFixed(2), 'of ' + sys.cpus + ' CPU', sys.load[0]/sys.cpus, sys.load[0] > sys.cpus),
    card('Owners', fmtNum(st.owners), 'avg ' + fmtBytes(st.avgBytesPerOwner) + '/owner'),
    card('Events', fmtNum(st.events), fmtNum(st.blobs) + ' blobs'),
    card('Stored', fmtBytes(st.storedBytes), 'DB file ' + fmtBytes(st.dbBytes)),
    card('Requests', fmtNum(tr.totalRequests), tr.requestsPerMin.toFixed(1) + '/min · ' + fmtNum(tr.totalErrors) + ' err'),
    (() => {
      const mc = s.maintenance && s.maintenance.lastCompaction;
      return card('Last compaction',
        mc ? fmtBytes(mc.reclaimedBytes) + ' freed' : '—',
        mc ? fmtNum(mc.deletedEvents) + ' events · ' + new Date(mc.ranAt).toLocaleTimeString() : 'not run yet');
    })(),
  ].join('');

  const hist = s.history || [];
  sparkline($('sp-stored'), hist.map(p => p.storedBytes), '#5b8def');
  sparkline($('sp-db'), hist.map(p => p.dbBytes), '#9b7dff');
  sparkline($('sp-disk'), hist.map(p => p.diskFreeBytes), '#3ad29f');
  sparkline($('sp-load'), hist.map(p => p.load1), '#e0a23f');

  $('endpoints').querySelector('tbody').innerHTML = Object.entries(tr.byEndpoint)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => '<tr><td>' + escapeHtml(k) + '</td><td class="num">' + fmtNum(v) + '</td></tr>').join('');

  $('owners').querySelector('tbody').innerHTML = (st.topOwners || [])
    .map(o => '<tr><td><code>' + escapeHtml(o.ownerId) + '</code></td><td class="num">' + fmtBytes(o.storedBytes) + '</td></tr>').join('');
}

function showLogin(msg) {
  $('app').hidden = true; $('login').hidden = false;
  if (msg) $('err').textContent = msg;
  $('token').focus();
}
$('go').onclick = () => {
  const t = $('token').value.trim();
  if (t) { sessionStorage.setItem(TOKEN_KEY, t); $('err').textContent = ''; tick(); }
};
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });

tick();
setInterval(tick, 5000);
</script>
</body>
</html>`
