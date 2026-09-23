// 端到端闭环测试：启动真实 HTTP 服务，操作独立测试库，结束后还原数据文件。
const { execSync, spawn } = require("child_process");
const { readFileSync, writeFileSync, existsSync } = require("fs");
const path = require("path");

const PORT = 3999;
const DB_FILE = path.join(__dirname, "data", "db.json");
const backup = readFileSync(DB_FILE, "utf8");
let server;

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = require("http").request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: urlPath,
        method,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("断言失败: " + msg);
  passed++;
  console.log("  ok -", msg);
}

async function main() {
  // 空库启动，由服务初始化
  const initial = { rubbings: [], damages: [], batches: [] };
  writeFileSync(DB_FILE, JSON.stringify(initial));
  server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(PORT) } });
  await new Promise((resolve, reject) => {
    server.stdout.on("data", () => resolve());
    server.on("exit", (code) => reject(new Error("服务提前退出 code=" + code)));
    setTimeout(resolve, 1500);
  });

  // 1. 建拓片 + 登记三个缺损（两个夹角合规，一个夹角 20 度）
  const rub = await req("POST", "/rubbings", { code: "T1", source: "s", paperSize: "1x1" });
  const rid = rub.body.data.id;
  const mk = (suffix, grain, dir, paper) =>
    req("POST", `/rubbings/${rid}/damages`, {
      position: "p" + suffix,
      type: "虫蛀孔",
      beforePhotoUrl: "u",
      grainAngle: grain,
      repairDirection: dir,
      paperBatchId: paper
    });
  const d1 = (await mk(1, 90, 90, "PB-1")).body.data;
  const d2 = (await mk(2, 0, 15, "PB-1")).body.data; // 边界 15° 合规
  const dBad = (await mk(3, 0, 35, "PB-1")).body.data; // 夹角 35°
  assert(d1.aligned === true && d1.angleDiff === 0, "登记返回夹角计算 aligned/angleDiff");
  assert(d2.aligned === true && d2.angleDiff === 15, "15度边界合规");
  assert(dBad.aligned === false && dBad.angleDiff === 35, "35度标记不对齐（登记允许，开工拦截）");

  // 缺字段 400
  const noField = await req("POST", `/rubbings/${rid}/damages`, { position: "x", type: "t", beforePhotoUrl: "u" });
  assert(noField.status === 400, "缺补纸三要素返回400");

  // 2. 含夹角超限项整批 409，归属与状态不变
  const blocked = await req("POST", "/batches", { name: "b", damageIds: [d1.id, dBad.id] });
  assert(blocked.status === 409, "夹角超限整批409");
  assert(blocked.body.details.violations.some((v) => v.type === "angle" && v.damageId === dBad.id), "409含angle违规明细");
  const d1after = (await req("GET", `/damages?batchId=`)).body.data.find((x) => x.id === d1.id);
  assert(d1after.status === "pending" && d1after.batchId === null, "409后原归属与状态不变");

  // 3. 合规开工
  const ok = await req("POST", "/batches", { name: "b", damageIds: [d1.id, d2.id] });
  assert(ok.status === 201 && ok.body.data.status === "open", "合规批次开工201");
  const inRepair = (await req("GET", "/damages?status=in_repair")).body.data;
  assert(inRepair.length === 2, "两项进入in_repair");

  // 4. 额度：再登记 7 个 PB-1 待开工（占用 2 + 新增 7 = 9 > 8）→ 409
  const more = [];
  for (let i = 0; i < 7; i++) more.push((await mk("m" + i, 0, 0, "PB-1")).body.data);
  const quotaBlock = await req("POST", "/batches", {
    name: "q",
    damageIds: more.map((x) => x.id)
  });
  assert(quotaBlock.status === 409, "同补纸批次累计超8项整批409");
  const qv = quotaBlock.body.details.violations.find((v) => v.type === "quota");
  assert(qv && qv.used === 2 && qv.adding === 7 && qv.total === 9 && qv.limit === 8, "额度违规明细 used/adding/total");

  // 5. 恰好 6 项（2+6=8）可以开工
  const six = more.slice(0, 6);
  const edge = await req("POST", "/batches", { name: "edge", damageIds: six.map((x) => x.id) });
  assert(edge.status === 201, "2+6=8恰好额度上限可开工");

  // 剩余 1 项在额度满后开工 409
  const left = more[6];
  const oneMore = await req("POST", "/batches", { name: "x", damageIds: [left.id] });
  assert(oneMore.status === 409 && oneMore.body.details.violations[0].type === "quota", "额度满后新增409");

  // 6. 开工后改角度 → 退回待复核、移出批次、释放占用
  const beforeUse = (await req("GET", "/batches")).body.data.find((b) => b.id === ok.body.data.id);
  assert(beforeUse.total === 2, "退回前批次含2项");
  const patch = await req("PATCH", `/damages/${d1.id}`, { repairDirection: 60 });
  assert(patch.status === 200 && patch.body.data.status === "review_pending", "改方向后退回review_pending");
  assert(patch.body.released === true && patch.body.data.batchId === null, "释放占用返回released且batchId清空");
  const afterUse = (await req("GET", "/batches")).body.data.find((b) => b.id === ok.body.data.id);
  assert(afterUse.total === 1 && afterUse.damages.every((x) => x.id !== d1.id), "批次移除退回项");

  // 释放后额度腾出：剩余1项可开工（PB-1 占用回到8-1=7，加1=8）
  const freed = await req("POST", "/batches", { name: "freed", damageIds: [left.id] });
  assert(freed.status === 201, "释放占用后额度可再用");

  // 开工项更换补纸批次被拒
  const swapPaper = await req("PATCH", `/damages/${d2.id}`, { paperBatchId: "PB-OTHER" });
  assert(swapPaper.status === 409, "开工项更换补纸批次409");

  // 7. 取消：开工项不可取消；未开工项可取消
  const cancelInRepair = await req("POST", `/damages/${d2.id}/cancel`);
  assert(cancelInRepair.status === 409, "已开工项取消409，占用不释放");
  const cancelReview = await req("POST", `/damages/${d1.id}/cancel`);
  assert(cancelReview.status === 200 && cancelReview.body.data.status === "cancelled", "待复核项（未开工）可取消");
  const cancelAgain = await req("POST", `/damages/${d1.id}/cancel`);
  assert(cancelAgain.status === 409, "已取消项重复取消409");

  // 8. 结项冻结用量
  const complete = await req("POST", `/batches/${ok.body.data.id}/complete`, {
    results: [{ damageId: d2.id, afterPhotoUrl: "after.jpg", repairNote: "完成" }]
  });
  assert(complete.status === 200 && complete.body.data.status === "completed", "结项200");
  assert(complete.body.data.frozenPaperUsage && complete.body.data.frozenPaperUsage["PB-1"] === 1, "结项冻结补纸用量");
  const frozenPatch = await req("PATCH", `/damages/${d2.id}`, { grainAngle: 5 });
  assert(frozenPatch.status === 409, "已结项不可改角度（冻结）");
  const frozenCancel = await req("POST", `/damages/${d2.id}/cancel`);
  assert(frozenCancel.status === 409, "已结项不可取消");
  const doubleComplete = await req("POST", `/batches/${ok.body.data.id}/complete`, {});
  assert(doubleComplete.status === 409, "重复结项409");

  // 冻结用量仍占额度：PB-1 此刻占用=1(冻结)+6+1=8，新 PB-1 项开工应 409
  const dNew = (await mk("new", 0, 0, "PB-1")).body.data;
  const frozenQuota = await req("POST", "/batches", { name: "fq", damageIds: [dNew.id] });
  assert(frozenQuota.status === 409, "结项冻结用量继续占用额度");

  // 9. 待核验历史迁移：手工构造缺字段旧数据
  const legacy = JSON.parse(readFileSync(DB_FILE, "utf8"));
  legacy.damages.push({
    id: "legacy_1",
    rubbingId: rid,
    position: "旧",
    type: "撕裂",
    beforePhotoUrl: "u",
    afterPhotoUrl: "",
    status: "pending",
    repairNote: "",
    batchId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    repairedAt: null
  });
  writeFileSync(DB_FILE, JSON.stringify(legacy));
  const listing = await req("GET", "/damages?status=unverified");
  const leg = listing.body.data.find((x) => x.id === "legacy_1");
  assert(leg && leg.status === "unverified", "历史缺方向迁移为unverified(待核验)");

  // 待核验项开工 409
  const legacyStart = await req("POST", "/batches", { name: "lg", damageIds: ["legacy_1"] });
  assert(legacyStart.status === 409, "待核验项开工409");

  // 补齐后先停留在 unverified，需显式 PATCH status=pending 完成复核
  await req("PATCH", "/damages/legacy_1", { grainAngle: 10, repairDirection: 12, paperBatchId: "PB-NEW" });
  const beforeRecheck = await req("GET", "/damages?status=unverified");
  assert(beforeRecheck.body.data.some((x) => x.id === "legacy_1"), "仅补齐字段未复核前保持unverified");
  const recheck = await req("PATCH", "/damages/legacy_1", { status: "pending" });
  assert(recheck.status === 200 && recheck.body.data.status === "pending", "显式复核通过回到pending");
  const legacyOk = await req("POST", "/batches", { name: "lg2", damageIds: ["legacy_1"] });
  assert(legacyOk.status === 201, "复核通过后可开工");

  // 10. 环绕夹角：350 vs 10 = 20 度（绕360取最小夹角）
  const wrap = (await mk("w", 350, 10, "PB-NEW")).body.data;
  assert(wrap.angleDiff === 20, "350与10最小圆周夹角为20");
  const wrapBlock = await req("POST", "/batches", { name: "w", damageIds: [wrap.id] });
  assert(wrapBlock.status === 409, "环绕夹角超限409");

  // 11. 健康检查含规则常量
  const health = await req("GET", "/health");
  assert(health.body.rules && health.body.rules.angleLimitDeg === 15 && health.body.rules.paperBatchLimit === 8, "health暴露规则常量");

  console.log(`\n全部通过 (${passed} 项断言)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.kill();
    writeFileSync(DB_FILE, backup);
    console.log("数据文件已还原");
  });
