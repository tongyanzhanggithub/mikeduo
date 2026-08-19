// 内置数据集的陈旧度判定（主进程）
//
// 为什么这件事值得单独一个模块：**用一份过期的制裁名单做合规判断，比不做更危险**。
// 不做的话用户知道自己没查；用旧名单查完显示"未命中"，他会以为查过了、是安全的。
// 这跟我们在联系人那边坚持的「测不出就说测不出」是同一条原则。
//
// 阈值按各份数据的真实更新频率定，不是拍脑袋：
//
//   制裁名单   OFAC 几乎每周都在动，BIS/UFLPA 数月一次。
//              90 天足以错过一整批新增主体 → 90 天提示，180 天醒目告警。
//   采购官库   人员流动以年计，公告本身也不是实时的 → 半年提示，一年告警。
//   HS 目录    HS 每 5 年才修订一次（现行 HS 2022）→ 两年提示足矣。
//
// 三份数据都随版本重建（tools/build-*.mjs），所以"陈旧"实际等价于
// "用户很久没更新过应用"——提示语里要说清这一点，否则他不知道该怎么办。

// 每份数据的阈值 + **各自的**措辞。
// 用同一套话去套三份数据会说出胡话：「采购官库过期导致新增主体查不到、
// 未命中不等于安全」——那是制裁名单的逻辑，采购官库根本没有"未命中"这回事。
const THRESHOLDS = {
  screening: {
    warn: 90,
    alert: 180,
    label: "制裁与实体名单",
    why: "OFAC 几乎每周都在变动",
    warnText: (d) => `建议更新应用。名单每晚一天，就多一批新增主体查不到。`,
    alertText: (d) =>
      `这 ${d} 天里新增的受限主体一律查不到——**筛查显示「未命中」不代表安全**。` +
      `请更新到最新版应用；在此之前，重大交易务必到 OFAC/BIS/DHS 官方站点自行复核。`
  },
  tenders: {
    warn: 180,
    alert: 365,
    label: "采购官联系人库",
    why: "人员调动与机构改组以年为单位发生",
    warnText: () => `部分联系人可能已经调岗，退信率会比刚建库时高。`,
    alertText: (d) =>
      `${d} 天前的联系人名单，调岗和离职会积累出可观的退信量。` +
      `发之前建议先跑一遍「验证邮箱真伪」，别让退信拖垮发信域名。`
  },
  hscodes: {
    warn: 730,
    alert: 1460,
    label: "HS 编码目录",
    why: "HS 每 5 年修订一次",
    warnText: () => `可能已经错过一次 HS 修订，新增子目查不到。`,
    alertText: () => `很可能落后了一整个 HS 版本，新增与调整过的子目都对不上，报关请以目的国现行税则为准。`
  }
};

function daysBetween(isoDate, now) {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(then)) return null;
  return Math.floor((now - then) / 86400000);
}

// builtAt: 'YYYY-MM-DD'，now 可注入便于测试
function ageOf(kind, builtAt, now = Date.now()) {
  const t = THRESHOLDS[kind];
  if (!t) return null;
  const days = daysBetween(builtAt, now);
  if (days === null) {
    return { kind, label: t.label, builtAt, days: null, level: "unknown", text: "构建日期读不出来，无法判断新旧" };
  }
  // 未来日期：多半是机器时钟不对，不要因此报"很新"
  if (days < 0) {
    return { kind, label: t.label, builtAt, days, level: "unknown", text: "构建日期晚于当前时间，请检查系统时钟" };
  }
  if (days >= t.alert) {
    return {
      kind,
      label: t.label,
      builtAt,
      days,
      level: "alert",
      text: `${t.label}已 ${days} 天没更新（${t.why}）。${t.alertText(days)}`
    };
  }
  if (days >= t.warn) {
    return {
      kind,
      label: t.label,
      builtAt,
      days,
      level: "warn",
      text: `${t.label}已 ${days} 天没更新（${t.why}）。${t.warnText(days)}`
    };
  }
  return { kind, label: t.label, builtAt, days, level: "ok", text: `${t.label}更新于 ${days} 天前` };
}

module.exports = { ageOf, THRESHOLDS, _internals: { daysBetween } };
