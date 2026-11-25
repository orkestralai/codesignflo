// Packs the built plugin into codesignflo-figma-plugin-<version>.zip for the designer:
// manifest.json + dist/ + THIRD_PARTY.md + INSTALL.md. Zipped here (no `zip` command needed: the website's
// build on Vercel packs it too, for codesignflo.com/plugin.zip).
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

const version = JSON.parse(readFileSync("package.json", "utf8")).version ?? "0.0.0";
const stage = "pack/CoDesignFlo";
rmSync("pack", { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// Figma only lets the plugin reach the domains its manifest lists: the service the release was built for
// (CODESIGNFLO_SERVICE_URL, else service/prod.json, as in build.mjs) is added — its API and its realtime socket.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
// The repo's manifest is the development plugin; the release is its own plugin in Figma (own sign-in), so
// both can be imported side by side.
// CODESIGNFLO_PLUGIN_FLAVOR=staging: a third plugin ("CoDesignFlo (staging)", own id, so own sign-in) for the
// staging service, importable beside the other two.
const flavor = process.env.CODESIGNFLO_PLUGIN_FLAVOR;
manifest.name = flavor ? `CoDesignFlo (${flavor})` : "CoDesignFlo";
// The release's id is the one Figma issued for the Community plugin (publishing only accepts that); the staging
// flavour keeps a made-up id, since it's only ever imported for development.
manifest.id = flavor ? `codesignflo-${flavor}` : "1705631511794382130";
const prod = () => JSON.parse(readFileSync("../../service/prod.json", "utf8"));
const service = process.env.CODESIGNFLO_SERVICE_URL ?? prod().url;
// The web app as build.mjs bakes it in: env, else prod.json when the service came from there.
const web = process.env.CODESIGNFLO_SERVICE_URL ? (process.env.CODESIGNFLO_SERVICE_WEB ?? "https://codesignflo.com") : prod().web;
if (service) {
  const u = new URL(service);
  const allowed = new Set(manifest.networkAccess.allowedDomains);
  allowed.add(u.origin);
  allowed.add(`${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`);
  // The web app: the panel asks it to send an invitation email right away.
  if (web) allowed.add(new URL(web).origin);
  manifest.networkAccess.allowedDomains = [...allowed];
} else console.warn("CODESIGNFLO_SERVICE_URL isn't set: this plugin works in local mode only (no sign-in, no service)");
writeFileSync(`${stage}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
cpSync("dist", `${stage}/dist`, { recursive: true });
cpSync("../../THIRD_PARTY.md", `${stage}/THIRD_PARTY.md`);
cpSync("INSTALL.md", `${stage}/INSTALL.md`);
const zip = `codesignflo-figma-plugin-${version}${flavor ? `-${flavor}` : ""}.zip`;
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
writeZip(
  zip,
  files(stage)
    .sort()
    .map((f) => ({ name: f.slice("pack/".length), data: readFileSync(f) })),
);
console.log(`packed packages/plugin/${zip}`);

/** A zip of these files (deflate), with fixed dates: the same bytes for the same files. */
function writeZip(path, entries) {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...parts, dir, end]));
}
