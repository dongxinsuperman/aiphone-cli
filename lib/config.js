"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".aiphone");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULT_BASE_URL = "";

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      return {};
    }
    throw new Error(`无法读取配置 ${CONFIG_FILE}: ${err.message}`);
  }
}

function writeConfigFile(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function getBaseUrl({ required = true } = {}) {
  if (process.env.AIPHONE_BASE_URL) {
    return process.env.AIPHONE_BASE_URL.replace(/\/+$/, "");
  }
  const cfg = readConfigFile();
  const url = cfg.baseUrl || DEFAULT_BASE_URL;
  if (!url && required) {
    throw new Error("尚未配置服务地址。请先运行 aiphone config set --url <你的 Server 地址>，或设置 AIPHONE_BASE_URL。");
  }
  return url.replace(/\/+$/, "");
}

function setBaseUrl(url) {
  const trimmed = url.replace(/\/+$/, "");
  const cfg = readConfigFile();
  cfg.baseUrl = trimmed;
  writeConfigFile(cfg);
  return trimmed;
}

function getConfigPath() {
  return CONFIG_FILE;
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_BASE_URL,
  getBaseUrl,
  setBaseUrl,
  getConfigPath,
  readConfigFile,
};
