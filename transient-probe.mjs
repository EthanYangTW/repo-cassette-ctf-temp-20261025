import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';

const client = internalArtifactTwirpClient();
const backend = getBackendIdsFromToken();
const endpoint = new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', process.env.ACTIONS_RESULTS_URL);
const root = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
const ghHeaders = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'repo-cassette-version-probe',
};

const variants = [
  ['v7-number', '7'],
  ['v7-float', '7.0'],
  ['v7-string', '"7"'],
  ['v7-exponent', '7e0'],
  ['v7-plus-wrap', '4294967303'],
  ['v7-minus-wrap', '-4294967289'],
  ['v7-int32-wrap', '2147483655'],
  ['v7-int64-wrap', '18446744073709551623'],
  ['v7-fraction', '7.0000000001'],
  ['v6-float', '6.9999999999'],
  ['v7-null', 'null'],
  ['v7-duplicate', '7,"version":6'],
  ['v6-duplicate', '6,"version":7'],
];

for (const [label, rawVersion] of variants) {
  const name = `version-${process.env.GITHUB_RUN_ID}-${label}`;
  const fields = JSON.stringify({ ...backend, name }).slice(0, -1);
  const body = `${fields},"version":${rawVersion},"mimeType":"application/json\\u0085"}`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok || !result.signedUploadUrl) {
      console.log('VERSION_REJECT', JSON.stringify({ label, status: response.status, error: result.msg || result.message || result.code }));
      continue;
    }
    const blob = new BlobClient(result.signedUploadUrl).getBlockBlobClient();
    await blob.uploadData(Buffer.from('{}'));
    const finished = await client.FinalizeArtifact({ ...backend, name, size: '2' });
    const id = finished.artifactId;
    const first = await fetch(`${root}/actions/artifacts/${id}/zip`, { headers: ghHeaders, redirect: 'manual' });
    const location = first.headers.get('location');
    const second = location ? await fetch(location) : null;
    const ct = second?.headers.get('content-type') ?? '';
    const target = location ? new URL(location) : null;
    console.log('VERSION_ACCEPT', JSON.stringify({ label, id, redirect: first.status, status: second?.status, ct, rsct: target?.searchParams.getAll('rsct') }));
    if (ct.includes('\u0085')) console.log('VERSION_CANDIDATE', JSON.stringify({ label, id, ct }));
    if (id) await fetch(`${root}/actions/artifacts/${id}`, { method: 'DELETE', headers: ghHeaders });
  } catch (error) {
    console.log('VERSION_ERROR', JSON.stringify({ label, error: String(error).slice(0, 240) }));
  }
}
