import { BlobClient } from '@azure/storage-blob';
import { internalArtifactTwirpClient } from './node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import { getBackendIdsFromToken } from './node_modules/@actions/artifact/lib/internal/shared/util.js';
import { StringValue } from './node_modules/@actions/artifact/lib/generated/index.js';

const client = internalArtifactTwirpClient();
const backend = getBackendIdsFromToken();
const body = Buffer.from('{"probe":"future-version"}');
const type = 'application/json\u0085';
const headers = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'repo-cassette-future-version-probe',
};
for (const version of [8, 9, 10, 11, 20, 99, 255]) {
  const name = `future-version-${version}-${process.env.GITHUB_RUN_ID}`;
  let created = false;
  try {
    const made = await client.CreateArtifact({
      ...backend, name, version, mimeType: StringValue.create({ value: type }),
    });
    created = made.ok;
    if (!created) throw new Error('CreateArtifact returned not ok');
    await new BlobClient(made.signedUploadUrl).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: { blobContentType: type },
    });
    const done = await client.FinalizeArtifact({ ...backend, name, size: String(body.length) });
    const id = String(done.artifactId);
    const first = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`,
      { headers, redirect: 'manual' },
    );
    const location = first.headers.get('location');
    const last = location ? await fetch(location) : null;
    const bytes = last ? Buffer.from(await last.arrayBuffer()) : null;
    console.log('VERSION', JSON.stringify({ version, id, status: first.status,
      rsct: location && new URL(location).searchParams.get('rsct'),
      finalStatus: last?.status, finalType: last?.headers.get('content-type'),
      bodyMatches: bytes?.equals(body) }));
  } catch (error) {
    console.log('VERSION_ERROR', JSON.stringify({ version, error: String(error).slice(0, 180) }));
  } finally {
    if (created) {
      try {
        const result = await client.DeleteArtifact({ ...backend, name });
        console.log('DELETE', version, result.ok);
      } catch (error) {
        console.log('DELETE_ERROR', version, String(error).slice(0, 120));
      }
    }
  }
}
