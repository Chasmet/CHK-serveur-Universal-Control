import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { CameraMaisonModule } from "../../src/camera.mjs";

const exec = promisify(execFile);
if (process.platform !== "win32") throw Error("Windows runner attendu");
const dir = await mkdtemp(join(tmpdir(), "camera-signing-win-"));
try {
  const svc = new CameraMaisonModule({ file: join(dir, "server.json"),
    base: "https://example.test" });
  const first = await svc.signing();
  const second = await svc.signing();
  assert.equal(first.storeType, "PKCS12");
  assert.equal(first.keystoreBase64, second.keystoreBase64);
  assert.equal(first.storePassword, second.storePassword);
  assert.equal(first.keyPassword, second.keyPassword);
  const filename = join(dir, "test.p12");
  await writeFile(filename, Buffer.from(first.keystoreBase64, "base64"));
  const { stdout } = await exec("keytool", [
    "-list", "-v", "-storetype", "PKCS12", "-keystore", filename,
    "-storepass:env", "CAMERA_TEST_PASSWORD"
  ], { env: { ...process.env, CAMERA_TEST_PASSWORD: first.storePassword },
       windowsHide: true, timeout: 30000, maxBuffer: 100000 });
  assert.match(stdout, /PrivateKeyEntry/);
  const source = join(dir, "camera-maison-signing", "release.pfx");
  await rename(source, source + ".isolated");
  await assert.rejects(svc.signing(), /signing_state_partial/);
  console.log("CAMERA_WINDOWS_SIGNING_SMOKE_OK: PKCS12 valide, clé persistante, rotation refusée");
} finally {
  await rm(dir, { recursive: true, force: true });
}
