import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const client = internalArtifactTwirpClient();
const backend = getBackendIdsFromToken();
const repo = process.env.GITHUB_REPOSITORY;
const root = `https://api.github.com/repos/${repo}`;
const gh = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'repo-cassette-name-collision-probe' };
const run = process.env.GITHUB_RUN_ID;
const pairs = [
  ['case', `COLLISION-${run}-A`, `collision-${run}-a`],
  ['nfc', `collision-${run}-é`, `collision-${run}-e\u0301`],
  ['trailing-space', `collision-${run}-space`, `collision-${run}-space `],
  ['trailing-dot', `collision-${run}-dot`, `collision-${run}-dot.`],
  ['slash-dot', `collision-${run}-slash`, `collision-${run}-x/../slash`],
  ['percent', `collision-${run}-pct`, `collision-${run}-%70ct`],
];
async function open(name, version) {
  const mime = version === 6 ? '\u0085application/json' : 'application/json';
  const x = await client.CreateArtifact({ ...backend, name, version, mimeType: StringValue.create({ value: mime }) });
  if (!x.ok || !x.signedUploadUrl) throw Error('create did not return URL');
  return { name, version, url: x.signedUploadUrl };
}
async function upload(x) {
  const body = Buffer.from(JSON.stringify({ label: x.name, version: x.version }));
  await new BlobClient(x.url).getBlockBlobClient().uploadData(body, { blobHTTPHeaders: { blobContentType: '\u0085application/json' } });
  return body.length;
}
async function seal(x, size) {
  const y = await client.FinalizeArtifact({ ...backend, name: x.name, size: String(size) });
  if (!y.ok || !y.artifactId) throw Error('finalize did not return ID');
  return String(y.artifactId);
}
async function probe(id) {
  const r = await fetch(`${root}/actions/artifacts/${id}/zip`, { headers: gh, redirect: 'manual' });
  const url = r.headers.get('location');
  if (!url) return { redirect: r.status };
  const b = await fetch(url);
  return { redirect: r.status, status: b.status, ct: b.headers.get('content-type'), body: (await b.text()).slice(0,150) };
}
for (const [label, firstName, secondName] of pairs) {
  const ids = [];
  try {
    const opened = await Promise.allSettled([open(firstName, 6), open(secondName, 7)]);
    const handles = opened.filter(x => x.status === 'fulfilled').map(x => x.value);
    const errors = opened.filter(x => x.status === 'rejected').map(x => String(x.reason).slice(0,160));
    for (const handle of handles) {
      try {
        const size = await upload(handle);
        const id = await seal(handle, size);
        ids.push(id);
        const result = await probe(id);
        console.log('COLLISION', JSON.stringify({ label, name: handle.name, version: handle.version, id, result }));
      } catch (e) { console.log('COLLISION_ERROR', JSON.stringify({ label, name: handle.name, version: handle.version, error: String(e).slice(0,160) })); }
    }
    console.log('PAIR', JSON.stringify({ label, accepted: handles.length, errors }));
  } catch (e) { console.log('PAIR_ERROR', JSON.stringify({ label, error: String(e).slice(0,160) })); }
  for (const id of [...new Set(ids)]) {
    const d = await fetch(`${root}/actions/artifacts/${id}`, { method: 'DELETE', headers: gh });
    console.log('CLEANUP', JSON.stringify({ id, status: d.status }));
  }
}
