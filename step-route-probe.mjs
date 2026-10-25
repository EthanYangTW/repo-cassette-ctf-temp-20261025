const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const base = `https://api.github.com/repos/${repo}`;
const common = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'repo-cassette-step-route-probe' };
const job = 121177729314;
for (const step of [1,2,3,4,5,6,7]) {
  const path = `/actions/jobs/${job}/steps/${step}/logs`;
  try {
    const response = await fetch(base + path, { headers: common, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const location = response.headers.get('location');
    let final = null;
    if (location && location.startsWith('https://')) {
      const target = new URL(location);
      const got = await fetch(location, { signal: AbortSignal.timeout(10000) });
      final = { host: target.hostname, status: got.status, ct: got.headers.get('content-type'), length: (await got.arrayBuffer()).byteLength };
    }
    console.log('STEP_ROUTE', JSON.stringify({ step, status: response.status, ct: response.headers.get('content-type'), final, error: location ? undefined : (await response.text()).slice(0,120) }));
  } catch (error) { console.log('STEP_ROUTE_ERROR', JSON.stringify({ step, error: String(error).slice(0,160) })); }
}
