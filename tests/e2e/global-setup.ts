/** Wait until the mock firewalls, the server and the web app all answer. */
export default async function globalSetup() {
  const urls = ["http://127.0.0.1:9443/", "http://127.0.0.1:9444/", "http://127.0.0.1:3100/api/health", "http://127.0.0.1:5273/"];
  const deadline = Date.now() + 90_000;
  for (const url of urls) {
    for (;;) {
      try {
        const res = await fetch(url);
        if (res.status < 500) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
