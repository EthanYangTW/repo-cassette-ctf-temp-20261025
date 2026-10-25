const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const base = `https://api.github.com/repos/${repo}`;
const common = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'repo-cassette-release-route-probe',
};
const tag = `cassette-route-${process.env.GITHUB_RUN_ID}`;
let release;

async function api(path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { ...common, ...options.headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
}

try {
  const created = await api('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: true }),
  });
  if (created.status !== 201) throw Error(`release ${created.status}: ${(await created.text()).slice(0, 160)}`);
  release = await created.json();
  const upload = new URL(release.upload_url.split('{', 1)[0]);
  upload.searchParams.set('name', 'probe.json');
  const uploaded = await fetch(upload, {
    method: 'POST',
    headers: { ...common, 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: `${repo}/probe`, owner: { avatar_url: 'file:///proc/self/environ' } }),
    signal: AbortSignal.timeout(10000),
  });
  if (uploaded.status !== 201) throw Error(`upload ${uploaded.status}: ${(await uploaded.text()).slice(0, 160)}`);
  const asset = await uploaded.json();
  const stem = `/releases/assets/${asset.id}`;
  console.log('ASSET_ID', asset.id);

  const paths = [
    stem,
    `${stem}?download=1`,
    `${stem}?download=true`,
    `${stem}?raw=1`,
    `${stem}?raw=true`,
    `${stem}?format=raw`,
    `${stem}?format=octet-stream`,
    `${stem}?media=raw`,
    `${stem}?media_type=application%2Foctet-stream`,
    `${stem}?content=1`,
    `${stem}?redirect=1`,
    `${stem}?inline=1`,
    `${stem}?response=raw`,
    `${stem}?archive_format=raw`,
    `${stem}?download=1&raw=1`,
    `${stem}/download`,
    `${stem}/raw`,
    `${stem}/content`,
    `/releases/${release.id}/assets/${asset.id}/download`,
    `/releases/download/${tag}/probe.json`,
  ];
  for (const path of paths) {
    try {
      const response = await api(path);
      const location = response.headers.get('location');
      let final;
      if (location?.startsWith('https://')) {
        const target = new URL(location);
        const fetched = await fetch(location, { signal: AbortSignal.timeout(10000) });
        final = { host: target.hostname, status: fetched.status, ct: fetched.headers.get('content-type'), rsct: target.searchParams.getAll('rsct') };
      }
      console.log('ROUTE', JSON.stringify({ path, status: response.status, ct: response.headers.get('content-type'), final }));
    } catch (error) {
      console.log('ROUTE_ERROR', JSON.stringify({ path, error: String(error).slice(0, 180) }));
    }
  }
} finally {
  if (release) {
    const deleted = await api(`/releases/${release.id}`, { method: 'DELETE' });
    const ref = await api(`/git/refs/tags/${tag}`, { method: 'DELETE' });
    console.log('CLEANUP', JSON.stringify({ release: deleted.status, tag: ref.status }));
  }
}
