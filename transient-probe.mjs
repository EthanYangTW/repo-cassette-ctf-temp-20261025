import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const client = internalArtifactTwirpClient();
const backend = getBackendIdsFromToken();
const name = `rsct-${process.env.GITHUB_RUN_ID}`;
const repo = process.env.GITHUB_REPOSITORY;
const root = `https://api.github.com/repos/${repo}`;
const gh = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'repo-cassette-rsct-probe' };
let id;
try {
  const opened = await client.CreateArtifact({ ...backend, name, version: 7, mimeType: StringValue.create({ value: 'application/json' }) });
  if (!opened.ok || !opened.signedUploadUrl) throw Error('create failed');
  const blob = new BlobClient(opened.signedUploadUrl).getBlockBlobClient();
  await blob.uploadData(Buffer.from('{"probe":true}'), { blobHTTPHeaders: { blobContentType: 'application/json' } });
  const done = await client.FinalizeArtifact({ ...backend, name, size: '14' });
  id = String(done.artifactId);
  const response = await fetch(`${root}/actions/artifacts/${id}/zip`, { headers: gh, redirect: 'manual' });
  const url = response.headers.get('location');
  if (!url) throw Error(`no signed URL: ${response.status}`);
  const suffix = '?';
  const variants = [
    ['baseline', url],
    ['duplicate-last-raw', url + '&rsct=application%2Fjson%85'],
    ['duplicate-last-utf8', url + '&rsct=application%2Fjson%C2%85'],
    ['duplicate-first-raw', url.replace(suffix, '?rsct=application%2Fjson%85&')],
    ['duplicate-first-utf8', url.replace(suffix, '?rsct=application%2Fjson%C2%85&')],
    ['duplicate-key-encoded', url + '&%72sct=application%2Fjson%85'],
    ['duplicate-key-case', url + '&RSCT=application%2Fjson%85'],
    ['duplicate-key-mixed', url + '&RsCt=application%2Fjson%85'],
    ['response-content-type', url + '&response-content-type=application%2Fjson%85'],
    ['mime-type', url + '&mime_type=application%2Fjson%85'],
  ];
  for (const [label, candidate] of variants) {
    try {
      const got = await fetch(candidate, { signal: AbortSignal.timeout(10000) });
      const body = await got.arrayBuffer();
      const ct = got.headers.get('content-type');
      console.log('RSCT', JSON.stringify({ label, status: got.status, ct, size: body.byteLength, candidate: got.status === 200 && ct?.includes('\u0085') }));
    } catch (error) { console.log('RSCT_ERROR', JSON.stringify({ label, error: String(error).slice(0,120) })); }
  }
} finally {
  if (id) {
    const deleted = await fetch(`${root}/actions/artifacts/${id}`, { method: 'DELETE', headers: gh });
    console.log('CLEANUP', JSON.stringify({ id, status: deleted.status }));
  }
}
