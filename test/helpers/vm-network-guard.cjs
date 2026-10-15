"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const profile = path.join(os.homedir(), ".aiphone", "config.json");
const originalRead = fs.readFileSync;
let profileReads = 0;
let requests = 0;
fs.readFileSync = function (filename, ...args) {
  if (typeof filename === "string" && path.resolve(filename) === profile) {
    profileReads += 1;
    throw new Error("VM compatibility tests refuse the real CLI profile");
  }
  return originalRead.call(this, filename, ...args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(input);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== process.env.VM_TEST_PORT) {
    throw new Error("VM compatibility tests refuse non-mock network targets");
  }
  requests += 1;
  return originalFetch(input, options);
};
process.on("exit", () => process.stderr.write("VM_TEST_GUARD " + JSON.stringify({ profileReads, requests, loopbackOnly: true }) + "\n"));
