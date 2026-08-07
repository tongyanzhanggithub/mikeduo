// 机器码采集（主进程）
//
// 口径（PRD F1）：CPU ID + 主板序列号 + 系统盘卷标 → SHA-256 → 取前 16 位 hex，
// 按 XXXX-XXXX-XXXX-XXXX 展示。
//
// 为什么不用 systeminformation：打包体积与原生依赖风险。Windows 上三项都能用
// 一次 PowerShell CIM 查询拿到；查询失败时退回"稳定但较弱"的兜底组合，
// 保证任何机器都能出码（出不了码 = 用户无法激活 = 收不到钱）。
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const PS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue';",
  "$c=(Get-CimInstance Win32_Processor | Select-Object -First 1).ProcessorId;",
  "$b=(Get-CimInstance Win32_BaseBoard | Select-Object -First 1).SerialNumber;",
  "$sys=$env:SystemDrive;",
  "$v=(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$sys'\").VolumeSerialNumber;",
  "Write-Output \"$c|$b|$v\""
].join(" ");

function runPowerShell() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) return resolve(null);
        const line = String(stdout).trim().split(/\r?\n/).pop() || "";
        const parts = line.split("|").map((s) => s.trim());
        if (parts.length < 3) return resolve(null);
        resolve(parts);
      }
    );
  });
}

// 兜底：机器型号 + CPU 型号+核数 + 总内存 + 主机名。换机会变、重装系统基本不变。
function fallbackParts() {
  const cpu = os.cpus()[0] || {};
  return ["fb", `${cpu.model || "cpu"}x${os.cpus().length}`, `${os.totalmem()}-${os.hostname()}`];
}

function formatMachineCode(hex16) {
  return hex16.toUpperCase().match(/.{1,4}/g).join("-");
}

let cached = null;

// 返回 { code: "7F3A-K2M9-QX41-B8CD", raw: "7f3a...", weak: bool }
async function getMachineCode() {
  if (cached) return cached;
  let parts = process.platform === "win32" ? await runPowerShell() : null;
  let weak = false;
  if (!parts || parts.every((p) => !p)) {
    parts = fallbackParts();
    weak = true;
  }
  const seed = parts.map((p) => (p || "-").trim()).join("|");
  const raw = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
  cached = { code: formatMachineCode(raw), raw, weak };
  return cached;
}

module.exports = { getMachineCode, formatMachineCode };
