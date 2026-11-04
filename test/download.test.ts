import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";

import { downloadFile } from "../src/embedded-sa3.js";

const FILE = Buffer.alloc(300_000);
for (let i = 0; i < FILE.length; i++) {
  FILE[i] = i % 251;
}

let server: http.Server;
let base = "";
let folder = "";
const ranges: Array<string | undefined> = [];

before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "gary-download-テスト-"));
  server = http.createServer((request, response) => {
    ranges.push(request.headers.range);
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    if (request.url === "/ignores-ranges" || !range) {
      response.writeHead(200, { "Content-Length": FILE.length });
      response.end(FILE);
      return;
    }
    const from = Number(range[1]);
    if (from >= FILE.length) {
      response.writeHead(416);
      response.end();
      return;
    }
    if (request.url === "/drops") {
      response.writeHead(206, { "Content-Length": FILE.length - from });
      response.write(FILE.subarray(from, from + 1000), () => response.destroy());
      return;
    }
    response.writeHead(206, { "Content-Length": FILE.length - from });
    response.end(FILE.subarray(from));
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(folder, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

test("a fresh download lands whole", async () => {
  const output = path.join(folder, "fresh.gguf");
  await downloadFile(`${base}/file`, output, () => {}, signal());
  assert.ok(FILE.equals(await fs.readFile(output)));
});

test("a partial file is picked up where it stopped", async () => {
  const output = path.join(folder, "resume.gguf");
  await fs.writeFile(`${output}.part`, FILE.subarray(0, 120_000));
  ranges.length = 0;
  let last = 0;
  await downloadFile(`${base}/file`, output, (progress) => {
    last = progress;
  }, signal());
  assert.deepEqual(ranges, ["bytes=120000-"]);
  assert.ok(FILE.equals(await fs.readFile(output)));
  assert.equal(last, 1);
});

test("a server that ignores the range starts it over rather than appending", async () => {
  const output = path.join(folder, "restart.gguf");
  await fs.writeFile(`${output}.part`, Buffer.alloc(5000, 7));
  await downloadFile(`${base}/ignores-ranges`, output, () => {}, signal());
  assert.ok(FILE.equals(await fs.readFile(output)));
});

test("a partial file that already has everything just finishes", async () => {
  const output = path.join(folder, "complete.gguf");
  await fs.writeFile(`${output}.part`, FILE);
  await downloadFile(`${base}/file`, output, () => {}, signal());
  assert.ok(FILE.equals(await fs.readFile(output)));
});

test("a dropped connection keeps the partial file and never passes for finished", async () => {
  const output = path.join(folder, "drops.gguf");
  await fs.writeFile(`${output}.part`, FILE.subarray(0, 50_000));
  await assert.rejects(downloadFile(`${base}/drops`, output, () => {}, signal()));
  await assert.rejects(fs.stat(output));
  assert.ok((await fs.stat(`${output}.part`)).size >= 50_000);
  await downloadFile(`${base}/file`, output, () => {}, signal());
  assert.ok(FILE.equals(await fs.readFile(output)));
});

test("cancelling keeps the partial file", async () => {
  const output = path.join(folder, "cancel.gguf");
  const controller = new AbortController();
  await fs.writeFile(`${output}.part`, FILE.subarray(0, 1000));
  controller.abort();
  await assert.rejects(downloadFile(`${base}/file`, output, () => {}, controller.signal));
  await assert.rejects(fs.stat(output));
  assert.equal((await fs.stat(`${output}.part`)).size, 1000);
});
