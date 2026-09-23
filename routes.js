// HTTP 路由：拓片、缺损登记、开工/取消/结项闭环。

const {
  RuleError,
  normalizeAngle,
  requirePaperBatchId,
  decorateDamage,
  validateStartBatch,
  assertCancelable,
  freezePaperUsage
} = require("./rules");
const { readDb, writeDb, makeId } = require("./storage");

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=&paperBatchId=&batchId=",
  "PATCH /damages/:id",
  "POST /damages/:id/cancel",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RuleError(400, "请求体必须是合法JSON");
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw new RuleError(400, `缺少字段：${missing.join(", ")}`);
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw new RuleError(404, "拓片不存在");
  return rubbing;
}

// 退回待复核：移出工作批次并释放补纸批次额度占用
function returnToReview(db, damage) {
  const batch = db.batches.find((item) => item.id === damage.batchId);
  if (batch) batch.damageIds = batch.damageIds.filter((id) => id !== damage.id);
  damage.batchId = null;
  damage.status = "review_pending";
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id)).map(decorateDamage);
  return {
    ...batch,
    damages,
    total: damages.length,
    inRepair: damages.filter((item) => item.status === "in_repair").length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length,
    paperBatchUsage:
      batch.status === "completed" && batch.frozenPaperUsage
        ? batch.frozenPaperUsage
        : livePaperUsage(damages)
  };
}

function livePaperUsage(damages) {
  const usage = {};
  for (const damage of damages) {
    if (!damage.paperBatchId || !["in_repair", "repaired"].includes(damage.status)) continue;
    usage[damage.paperBatchId] = (usage[damage.paperBatchId] || 0) + 1;
  }
  return usage;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "rubbing-repair-api",
      rules: { angleLimitDeg: 15, paperBatchLimit: 8 },
      routes
    });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const data = db.damages.filter((item) => item.rubbingId === rubbingId).map(decorateDamage);
    return send(res, 200, { data });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl", "grainAngle", "repairDirection", "paperBatchId"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      grainAngle: normalizeAngle(body.grainAngle, "纸纹角度"),
      repairDirection: normalizeAngle(body.repairDirection, "补纸方向"),
      paperBatchId: requirePaperBatchId(body.paperBatchId),
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: decorateDamage(damage) });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const paperBatchId = url.searchParams.get("paperBatchId");
    const batchId = url.searchParams.get("batchId");
    const data = db.damages
      .filter(
        (item) =>
          (!status || item.status === status) &&
          (!type || item.type === type) &&
          (!paperBatchId || item.paperBatchId === paperBatchId) &&
          (!batchId || item.batchId === batchId)
      )
      .map(decorateDamage);
    return send(res, 200, { data });
  }

  const damageCancelMatch = pathname.match(/^\/damages\/([^/]+)\/cancel$/);
  if (damageCancelMatch && req.method === "POST") {
    const damage = db.damages.find((item) => item.id === damageCancelMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    assertCancelable(damage); // 已开工/已结项一律 409，占用不释放
    damage.status = "cancelled";
    damage.batchId = null;
    await writeDb(db);
    return send(res, 200, { data: decorateDamage(damage) });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);

    if (damage.status === "repaired") {
      return send(res, 409, { error: "缺损项已结项，角度、方向与用量均已冻结" });
    }
    if (damage.status === "cancelled") {
      return send(res, 409, { error: "缺损项已取消，不能修改" });
    }

    // 开工后不允许更换补纸批次（额度归属不可挪动）
    if (body.paperBatchId !== undefined && damage.status === "in_repair" && body.paperBatchId !== damage.paperBatchId) {
      return send(res, 409, { error: "缺损项已开工，不能更换补纸批次；如需调整请先退回待复核" });
    }

    const nextGrain = body.grainAngle !== undefined ? normalizeAngle(body.grainAngle, "纸纹角度") : damage.grainAngle;
    const nextDirection =
      body.repairDirection !== undefined ? normalizeAngle(body.repairDirection, "补纸方向") : damage.repairDirection;
    const nextPaper = body.paperBatchId !== undefined ? requirePaperBatchId(body.paperBatchId) : damage.paperBatchId;

    damage.position = body.position ?? damage.position;
    damage.type = body.type ?? damage.type;
    damage.beforePhotoUrl = body.beforePhotoUrl ?? damage.beforePhotoUrl;
    damage.afterPhotoUrl = body.afterPhotoUrl ?? damage.afterPhotoUrl;
    damage.repairNote = body.repairNote ?? damage.repairNote;
    damage.grainAngle = nextGrain;
    damage.repairDirection = nextDirection;
    damage.paperBatchId = nextPaper;

    // 开工后角度或方向变化：该项退回待复核并释放占用；
    // 其他字段（照片、备注等）可照常更新，但不能更换补纸批次或直接改状态。
    const directionChanged = body.grainAngle !== undefined || body.repairDirection !== undefined;
    if (damage.status === "in_repair") {
      if (body.status !== undefined && body.status !== "in_repair") {
        return send(res, 409, { error: "开工项不能直接改状态；改角度或方向将退回待复核" });
      }
      if (directionChanged) {
        returnToReview(db, damage);
        await writeDb(db);
        return send(res, 200, { data: decorateDamage(damage), released: true });
      }
    } else if (body.status !== undefined) {
      const complete = damage.grainAngle != null && damage.repairDirection != null && !!damage.paperBatchId;
      if (body.status === "pending") {
        if (!complete) {
          return send(res, 400, { error: "纸纹角度、补纸方向、补纸批次未补齐，不能结束核验" });
        }
        damage.status = "pending";
      } else if (body.status === "review_pending") {
        damage.status = "review_pending";
      } else if (body.status === "unverified") {
        damage.status = "unverified";
      } else if (body.status === "in_repair") {
        return send(res, 400, { error: "开工请通过 POST /batches，需通过夹角与补纸批次额度校验" });
      } else if (body.status === "repaired") {
        return send(res, 400, { error: "结项请通过 POST /batches/:id/complete，结项后用量冻结" });
      } else if (body.status === "cancelled") {
        return send(res, 400, { error: "取消请通过 POST /damages/:id/cancel" });
      } else {
        return send(res, 400, { error: `未知状态：${body.status}` });
      }
    }

    await writeDb(db);
    return send(res, 200, { data: decorateDamage(damage) });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      return send(res, 400, { error: "damageIds必须是非空数组" });
    }
    const damageIds = [...new Set(body.damageIds)];
    if (damageIds.length !== body.damageIds.length) {
      return send(res, 400, { error: "damageIds存在重复项" });
    }
    // 整批校验：夹角超限或补纸批次累计超八项则 409，此处不写库，原归属与状态不变
    try {
      validateStartBatch(db, damageIds);
    } catch (error) {
      if (error.status === 409 || error.status === 400) {
        return send(res, error.status, { error: error.message, details: error.details });
      }
      throw error;
    }
    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds,
      note: body.note || "",
      frozenPaperUsage: null,
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status === "completed") {
      return send(res, 409, { error: "修补批次已结项，用量已冻结" });
    }
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    batch.frozenPaperUsage = freezePaperUsage(db, batch.damageIds); // 结项冻结用量
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { handle, routes, send };
