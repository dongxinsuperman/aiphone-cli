"use strict";

function printJson(data, { pretty = true } = {}) {
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  process.stdout.write(`${text}\n`);
}

function printError(err) {
  if (err.name === "ApiError") {
    process.stderr.write(`错误: ${err.message}\n`);
    if (err.body && process.env.AIPHONE_DEBUG) {
      process.stderr.write(`${JSON.stringify(err.body, null, 2)}\n`);
    }
    process.exitCode = err.status && err.status >= 400 && err.status < 600 ? 1 : 1;
    return;
  }
  process.stderr.write(`错误: ${err.message}\n`);
  process.exitCode = 1;
}

module.exports = { printJson, printError };
