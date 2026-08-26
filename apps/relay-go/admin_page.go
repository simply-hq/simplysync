package main

// Self-contained operational dashboard (no external assets/CDNs, CSP-clean).
// It prompts for the admin token, keeps it in sessionStorage, polls <base>/stats
// (derived from its own path — the base is secret), and renders the relay's
// storage/traffic counters. Host capacity (disk/mem/load) is the platform's job.
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
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .card {
    background: #15171e; border: 1px solid #20232c; border-radius: 12px; padding: 14px 16px;
  }
  .card h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b90a0; font-weight: 600; }
  .card .val { font-size: 22px; font-weight: 650; }
  .card .sub { color: #8b90a0; font-size: 12px; margin-top: 2px; }
  section { margin-top: 24px; }
  section h2 { font-size: 13px; color: #8b90a0; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #20232c; }
  th { color: #8b90a0; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
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
    <div class="grid" id="cards"></div>

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
function card(title, val, sub) {
  return '<div class="card"><h3>' + title + '</h3><div class="val">' + val +
    '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
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

  $('host').textContent = s.system.hostname;
  $('uptime').textContent = 'up ' + fmtDur(s.uptimeMs);
  $('updated').textContent = 'updated ' + new Date(s.now).toLocaleTimeString();

  const st = s.storage, tr = s.traffic;
  $('cards').innerHTML = [
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
