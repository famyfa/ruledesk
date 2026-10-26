import { connect } from "node:tls";

/**
 * Print a firewall's TLS certificate fingerprint for "tlsFingerprint" in the topology.
 *   npm run fingerprint -- 192.0.2.10 [port]
 * Compare it with the certificate shown in OPNsense (System > Trust > Certificates)
 * before trusting it: the first connection could itself be intercepted.
 */
const host = process.argv[2];
const port = Number(process.argv[3] ?? 443);
if (!host) {
  console.error("Usage: npm run fingerprint -- <host> [port]");
  process.exit(1);
}
const socket = connect({ host, port, rejectUnauthorized: false, servername: /^[\d.]+$|:/.test(host) ? undefined : host, timeout: 10000 }, () => {
  const c = socket.getPeerCertificate();
  console.log(`${host}:${port}`);
  console.log(`  subject : ${c.subject?.CN ?? JSON.stringify(c.subject)}`);
  console.log(`  issuer  : ${c.issuer?.CN ?? JSON.stringify(c.issuer)}`);
  console.log(`  valid   : ${c.valid_from} -> ${c.valid_to}`);
  console.log(`  sha256  : ${c.fingerprint256}`);
  socket.end();
});
socket.on("timeout", () => {
  console.error(`${host}:${port}: timed out`);
  socket.destroy();
  process.exit(2);
});
socket.on("error", (e) => {
  console.error(`${host}:${port}: ${e.message}`);
  process.exit(2);
});
