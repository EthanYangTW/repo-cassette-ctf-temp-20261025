import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const client = internalArtifactTwirpClient();
const backend = getBackendIdsFromToken();
const blobType = 'application/json\u0085';
const body = Buffer.from('{"probe":"no-mime"}');
const root = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
const headers = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'repo-cassette-no-mime-probe',
};

for (const [label, mime] of [
  ['omitted', undefined],
  ['empty', ''],
  ['plain', 'application/json'],
]) {
  const name = `no-mime-${label}-${process.env.GITHUB_RUN_ID}`;
  let created = false;
  try {
    const args = { ...backend, name, version: 7 };
    if (mime !== undefined) args.mimeType = StringValue.create({ value: mime });
    const made = await client.CreateArtifact(args);
    created = made.ok;
    if (!created) throw new Error('CreateArtifact returned not ok');
    await new BlobClient(made.signedUploadUrl).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: { blobContentType: blobType },
    });
    const done = await client.FinalizeArtifact({ ...backend, name, size: String(body.length) });
    const id = String(done.artifactId);
    const first = await fetch(`${root}/actions/artifacts/${id}/zip`, {
      headers, redirect: 'manual',
    });
    const location = first.headers.get('location');
    const last = location ? await fetch(location) : null;
    const bytes = last ? Buffer.from(await last.arrayBuffer()) : null;
    console.log('MIME', JSON.stringify({ label, id, status: first.status,
      rsct: location && new URL(location).searchParams.get('rsct'),
      finalStatus: last?.status, finalType: last?.headers.get('content-type'),
      bodyMatches: bytes?.equals(body), size: bytes?.length }));
  } catch (error) {
    console.log('MIME_ERROR', JSON.stringify({ label, error: String(error).slice(0, 200) }));
  } finally {
    if (created) {
      try {
        const result = await client.DeleteArtifact({ ...backend, name });
        console.log('DELETE', label, result.ok);
      } catch (error) {
        console.log('DELETE_ERROR', label, String(error).slice(0, 140));
      }
    }
  }
}
