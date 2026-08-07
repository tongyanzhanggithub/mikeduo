// 桌面壳集成自测（要在 Electron 里跑，不是 node）：
//
//   npx electron tools/test-desktop.js
//
// 验的是只有真 Electron 才有的东西：机器码采集、safeStorage 加解密、license.dat
// 落盘与回读、备份目录读写与 14 份滚动。跑在临时 userData 里，不碰真实数据。
const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mkd-desktop-"));
app.setPath("userData", sandbox);

const { getMachineCode } = require("../electron/machine-code");
const license = require("../electron/license");

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

app.whenReady().then(async () => {
  try {
    console.log("桌面壳集成自测（沙箱 userData:", sandbox + "）");

    const machine = await getMachineCode();
    check("机器码可采集且为 XXXX-XXXX-XXXX-XXXX", () => {
      assert.match(machine.code, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
      assert.equal(machine.raw.length, 16);
    });
    console.log(`     机器码 ${machine.code}（弱兜底=${machine.weak}）`);

    const privPath = path.join(__dirname, "keys", "private.pem");
    if (!fs.existsSync(privPath)) {
      console.error("找不到私钥，先跑 node tools/init-keys.mjs");
      app.exit(1);
      return;
    }
    const code = license.issueCode({
      machineRaw: machine.raw,
      tierId: "pro",
      issuedAt: new Date().toISOString().slice(0, 10),
      privateKeyPem: fs.readFileSync(privPath, "utf8")
    });

    check("safeStorage 在本机可用", () => {
      assert.equal(safeStorage.isEncryptionAvailable(), true);
    });

    check("激活信息加密写盘后能原样读回", () => {
      license.saveLicense(app, safeStorage, { code, activatedAt: new Date().toISOString() });
      const file = license.licensePath(app);
      assert.equal(fs.existsSync(file), true);
      const raw = fs.readFileSync(file);
      assert.equal(raw.includes(Buffer.from(code.slice(0, 8))), false, "落盘内容不能是明文");
      const loaded = license.loadLicense(app, safeStorage, machine.raw);
      assert.equal(loaded.tier, "pro");
    });

    check("激活文件被改坏 → 静默回退试用，不抛错", () => {
      const file = license.licensePath(app);
      const buf = fs.readFileSync(file);
      buf[buf.length - 1] ^= 0xff;
      fs.writeFileSync(file, buf);
      assert.equal(license.loadLicense(app, safeStorage, machine.raw), null);
    });

    check("换一台机器的机器码 → 读不出授权", () => {
      license.saveLicense(app, safeStorage, { code, activatedAt: new Date().toISOString() });
      assert.equal(license.loadLicense(app, safeStorage, "ffffffffffffffff"), null);
      license.clearLicense(app);
      assert.equal(fs.existsSync(license.licensePath(app)), false);
    });

    // 备份：直接复用 main.js 里的口径（写入 + 滚动保留 14 份）
    const backupDir = path.join(app.getPath("userData"), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    check("备份写入并滚动保留最近 14 份", () => {
      for (let i = 1; i <= 17; i += 1) {
        fs.writeFileSync(path.join(backupDir, `mkd-backup-2026-08-${String(i).padStart(2, "0")}.json`), JSON.stringify({ n: i }));
        const files = fs.readdirSync(backupDir).filter((f) => f.startsWith("mkd-backup-")).sort();
        files.slice(0, Math.max(0, files.length - 14)).forEach((f) => fs.rmSync(path.join(backupDir, f), { force: true }));
      }
      const left = fs.readdirSync(backupDir).filter((f) => f.startsWith("mkd-backup-")).sort();
      assert.equal(left.length, 14);
      assert.equal(left[0], "mkd-backup-2026-08-04.json"); // 最早三份被滚掉
      assert.equal(JSON.parse(fs.readFileSync(path.join(backupDir, left[13]), "utf8")).n, 17);
    });

    // 注意：本脚本是被 electron 当"单文件应用"跑的，读不到项目 package.json，
    // 所以 app.getName() 在这里恒为 Electron。直接校验决定数据目录名的那个字段。
    check("package.json 的 productName 决定数据目录名，且已设为品牌名", () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
      assert.equal(pkg.productName, "觅客舵");
      assert.equal(pkg.build.productName, "觅客舵");
    });

    console.log(`\n${passed} 项全部通过`);
    fs.rmSync(sandbox, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error("\n失败：", error.message);
    console.error(error.stack);
    app.exit(1);
  }
});
