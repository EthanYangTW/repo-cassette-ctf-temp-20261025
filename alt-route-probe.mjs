import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const client = internalArtifactTwirpClient();
const backend = getBackendIdsFromToken();
const name = `alt-route-${process.env.GITHUB_RUN_ID}`;
const weirdType = 'application/json\u0085';
const body = Buffer.from('{"probe":"alt-route"}');
const root = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
const headers = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'repo-cassette-alt-route-probe',
};

let created = false;
try {
  const made = await client.CreateArtifact({
    ...backend, name, version: 6,
    mimeType: StringValue.create({ value: weirdType }),
  });
  if (!made.ok) throw new Error('CreateArtifact returned not ok');
  created = true;
  await new BlobClient(made.signedUploadUrl).getBlockBlobClient().uploadData(body, {
    blobHTTPHeaders: { blobContentType: weirdType },
  });
  const done = await client.FinalizeArtifact({
    ...backend, name, size: String(body.length),
  });
  const id = String(done.artifactId);
  console.log('ARTIFACT_ID', id);

  const paths = [
    `actions/artifacts/${id}/zip`,
    `actions/artifacts/${id}/zip/`,
    `actions/artifacts/${id}/download`,
    `actions/artifacts/${id}/raw`,
    `actions/artifacts/${id}/file`,
    `actions/artifacts/${id}/content`,
    `actions/artifacts/${id}/archive`,
    `actions/artifacts/${id}/zip.json`,
    `actions/artifacts/${id}/zip;`,
    `actions/artifacts/${id}/zip;.json`,
    `actions/artifacts/${id}/zip%3B`,
    `actions/artifacts/${id}/%7aip`,
    `actions/artifacts/${id}/%2e/zip`,
    `actions/artifacts/${id}/zip/%2e`,
    `actions/artifacts/${id}/zip/..`,
    `actions/artifacts/${id}/zip?redirect=false`,
    `actions/artifacts/${id}/zip?download=false`,
    `actions/artifacts/${id}/zip?format=raw`,
    `actions/artifacts/${id}/zip?archive_format=raw`,
    `actions/artifacts/${id}/zip?raw=1`,
    `actions/artifacts/${id}/zip?ref=main`,
    `actions/runs/${process.env.GITHUB_RUN_ID}/artifacts/${id}/zip`,
    `actions/runs/${process.env.GITHUB_RUN_ID}/artifacts/${id}/download`,
    `actions/runs/${process.env.GITHUB_RUN_ID}/artifacts/${id}`,
    `actions/artifacts/${id}`,
    `actions/artifacts/${id}/contents`,
    `actions/artifacts/${id}/files`,
  ];
  for (const path of paths) {
    try {
      const first = await fetch(`${root}/${path}`, { headers, redirect: 'manual' });
      const location = first.headers.get('location');
      let final;
      if (location?.startsWith('https://')) {
        const fetched = await fetch(location);
        const bytes = Buffer.from(await fetched.arrayBuffer());
        final = {
          status: fetched.status,
          contentType: fetched.headers.get('content-type'),
          bodyMatches: bytes.equals(body),
          size: bytes.length,
          rsct: new URL(location).searchParams.get('rsct'),
        };
      }
      console.log('ROUTE', JSON.stringify({ path, status: first.status,
        contentType: first.headers.get('content-type'), final }));
    } catch (error) {
      console.log('ROUTE_ERROR', JSON.stringify({ path, error: String(error).slice(0, 160) }));
    }
  }
} finally {
  if (created) {
    try {
      const deleted = await client.DeleteArtifact({ ...backend, name });
      console.log('DELETE', deleted.ok);
    } catch (error) {
      console.log('DELETE_ERROR', String(error).slice(0, 160));
    }
  }
}
