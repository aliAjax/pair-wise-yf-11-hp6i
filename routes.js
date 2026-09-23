"use strict";

// 路由层：HTTP 解析与拓片修补 / 补纸纤维闭环的业务编排。

const { readDb, writeDb, makeId, enrichBatch } = require("./storage");
const {
  FIBER_ANGLE_LIMIT,
  PAPER_BATCH_QUOTA,
  DAMAGE_STATUS,
  BATCH_STATUS,
  RuleError,
  asAngle,
  hasFiberProfile,
  fiberAngleGap,
  countPaperBatchUsage,
  assertFiberBatch,
  assertPaperBatchQuota,
  releaseToReview,
  releaseQueued,
  freezeRepaired,
  isFiberField
} = require("./rules");

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=&patchBatchId=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/start",
  "POST /batches/:id/cancel",
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
    throw new RuleError("请求体必须是合法JSON", 400, "invalid_json");
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    throw new RuleError(`缺少字段：${missing.join(", ")}`, 400, "missing_field");
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw new RuleError("拓片不存在", 404, "rubbing_not_found");
  return rubbing;
}

function findDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) throw new RuleError("缺损项不存在", 404, "damage_not_found");
  return damage;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) throw new RuleError("修补批次不存在", 404, "batch_not_found");
  return batch;
}

// 从 PATCH 请求中解析纤维登记（grainAngle / patchDirection / patchBatchId），
// 返回的对象只包含显式提交的字段；角度字段就地校验。
function pickFiberPatch(body) {
  const patch = {};
  if (body.grainAngle !== undefined) patch.grainAngle = asAngle(body.grainAngle, "grainAngle");
  if (body.patchDirection !== undefined) patch.patchDirection = asAngle(body.patchDirection, "patchDirection");
  if (body.patchBatchId !== undefined) {
    if (typeof body.patchBatchId !== "string" || body.patchBatchId.trim() === "") {
      throw new RuleError("patchBatchId 必须是非空字符串", 400, "invalid_patch_batch");
    }
    patch.patchBatchId = body.patchBatchId.trim();
  }
  return patch;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "rubbing-repair-api",
      fiberAngleLimit: FIBER_ANGLE_LIMIT,
      paperBatchQuota: PAPER_BATCH_QUOTA,
      routes
    });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== DAMAGE_STATUS.REPAIRED).length
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
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl", "grainAngle", "patchBatchId", "patchDirection"]);
    const fiberPatch = pickFiberPatch(body);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: DAMAGE_STATUS.PENDING,
      repairNote: "",
      batchId: null,
      grainAngle: fiberPatch.grainAngle,
      patchBatchId: fiberPatch.patchBatchId,
      patchDirection: fiberPatch.patchDirection,
      createdAt: new Date().toISOString(),
      startedAt: null,
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, {
      data: { ...damage, fiberAngleGap: fiberAngleGap(damage) }
    });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const patchBatchId = url.searchParams.get("patchBatchId");
    const data = db.damages.filter(
      (item) =>
        (!status || item.status === status) &&
        (!type || item.type === type) &&
        (!patchBatchId || item.patchBatchId === patchBatchId)
    );
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = findDamage(db, damagePatchMatch[1]);
    const body = await parseBody(req);

    // 结项后用量冻结：纤维登记、补纸归属与状态均不可改，仅允许补充备注/照片。
    const fiberPatch = pickFiberPatch(body);
    if (damage.status === DAMAGE_STATUS.REPAIRED) {
      if (Object.keys(fiberPatch).length || (body.status && body.status !== DAMAGE_STATUS.REPAIRED)) {
        throw new RuleError("该项已结项，用量已冻结，不可修改纤维方向、补纸批次或状态", 409, "repair_frozen");
      }
    }

    const fiberChanged = Object.keys(fiberPatch).some((field) => damage[field] !== fiberPatch[field]);

    // 未开工但已占额（queued）：换补纸批次需重新过额度；同批角度不在保存时拦截，留到开工闸口。
    if (damage.status === DAMAGE_STATUS.QUEUED && fiberPatch.patchBatchId && fiberPatch.patchBatchId !== damage.patchBatchId) {
      assertPaperBatchQuota(db, fiberPatch.patchBatchId, 1, [damage.id]);
    }

    Object.assign(damage, fiberPatch);

    // 开工后角度或方向（含补纸批次）变化：该项退回待复核并释放占用。
    if (fiberChanged && damage.status === DAMAGE_STATUS.IN_REPAIR) {
      const previousBatchId = damage.batchId;
      releaseToReview(damage);
      if (previousBatchId) {
        const ownerBatch = db.batches.find((item) => item.id === previousBatchId);
        if (ownerBatch) ownerBatch.damageIds = ownerBatch.damageIds.filter((id) => id !== damage.id);
      }
    }

    // 待核验项补齐纤维登记且夹角合规后自动回到待排单。
    if (
      damage.status === DAMAGE_STATUS.AWAITING_VERIFICATION &&
      hasFiberProfile(damage) &&
      fiberAngleGap(damage) <= FIBER_ANGLE_LIMIT
    ) {
      damage.status = DAMAGE_STATUS.PENDING;
    }

    if (body.status !== undefined) {
      const next = body.status;
      if (next === DAMAGE_STATUS.PENDING) {
        if (![DAMAGE_STATUS.AWAITING_VERIFICATION, DAMAGE_STATUS.AWAITING_REVIEW].includes(damage.status)) {
          throw new RuleError(`仅待核验/待复核项可回到待排单，当前状态 ${damage.status}`, 409, "invalid_status_transition");
        }
        if (!hasFiberProfile(damage)) {
          throw new RuleError("纤维登记不完整，不能回到待排单", 409, "fiber_profile_missing");
        }
        if (fiberAngleGap(damage) > FIBER_ANGLE_LIMIT) {
          throw new RuleError(`纸纹与补纸方向夹角超过 ${FIBER_ANGLE_LIMIT}°，复核不通过`, 409, "fiber_angle_mismatch", {
            gap: fiberAngleGap(damage)
          });
        }
        damage.status = DAMAGE_STATUS.PENDING;
        damage.batchId = null;
        damage.startedAt = null;
      } else if (next === DAMAGE_STATUS.REPAIRED) {
        if (damage.status !== DAMAGE_STATUS.IN_REPAIR) {
          throw new RuleError("只有已开工项可以结项", 409, "invalid_status_transition");
        }
        damage.status = DAMAGE_STATUS.REPAIRED;
        damage.repairedAt = new Date().toISOString();
      } else if (next !== damage.status) {
        // queued / in_repair 只能通过修补批次接口流转，避免绕过额度与夹角闸口。
        throw new RuleError(`不支持直接把状态改为 ${next}，请通过修补批次接口操作`, 409, "invalid_status_transition");
      }
    }

    if (body.position !== undefined) damage.position = body.position;
    if (body.type !== undefined) damage.type = body.type;
    if (body.beforePhotoUrl !== undefined) damage.beforePhotoUrl = body.beforePhotoUrl;
    if (body.afterPhotoUrl !== undefined) damage.afterPhotoUrl = body.afterPhotoUrl;
    if (body.repairNote !== undefined) damage.repairNote = body.repairNote;

    await writeDb(db);
    return send(res, 200, {
      data: {
        ...damage,
        fiberAngleGap: hasFiberProfile(damage) ? fiberAngleGap(damage) : null,
        paperBatchUsed: damage.patchBatchId ? countPaperBatchUsage(db, damage.patchBatchId) : null
      }
    });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      throw new RuleError("damageIds必须是非空数组", 400, "invalid_damage_ids");
    }
    const damageIds = [...new Set(body.damageIds)];
    if (damageIds.length !== body.damageIds.length) {
      throw new RuleError("damageIds 存在重复项", 400, "duplicate_damage_ids");
    }
    const invalid = damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) throw new RuleError(`缺损项不存在：${invalid.join(", ")}`, 400, "damage_not_found");

    const candidates = damageIds.map((id) => db.damages.find((damage) => damage.id === id));

    // 整批校验：夹角超限或补纸批次累计超额，整批 409，原归属与状态不变（此刻尚未写库）。
    assertFiberBatch(db, candidates, [DAMAGE_STATUS.PENDING]);

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: BATCH_STATUS.OPEN,
      damageIds,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      cancelledAt: null
    };
    db.batches.push(batch);
    candidates.forEach((damage) => {
      damage.batchId = batch.id;
      damage.status = DAMAGE_STATUS.QUEUED; // 已占额、未开工
      damage.startedAt = null;
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = findBatch(db, batchMatch[1]);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const startMatch = pathname.match(/^\/batches\/([^/]+)\/start$/);
  if (startMatch && req.method === "POST") {
    const batch = findBatch(db, startMatch[1]);
    if (batch.status !== BATCH_STATUS.OPEN) {
      throw new RuleError(`批次已${batch.status === BATCH_STATUS.COMPLETED ? "结项" : "取消"}，不能开工`, 409, "batch_not_open");
    }
    const body = await parseBody(req);
    let targets = db.damages.filter((item) => batch.damageIds.includes(item.id));
    if (body.damageIds !== undefined) {
      if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
        throw new RuleError("damageIds 必须是非空数组", 400, "invalid_damage_ids");
      }
      const outsider = body.damageIds.filter((id) => !batch.damageIds.includes(id));
      if (outsider.length) throw new RuleError(`缺损项不属于该批次：${outsider.join(", ")}`, 400, "damage_not_in_batch");
      targets = body.damageIds.map((id) => findDamage(db, id));
    }

    // 开工闸口：未开工项再次整批校验夹角与额度（防止排单后数据被改）。
    assertFiberBatch(db, targets, [DAMAGE_STATUS.QUEUED]);

    const nowIso = new Date().toISOString();
    targets.forEach((damage) => {
      damage.status = DAMAGE_STATUS.IN_REPAIR;
      damage.startedAt = damage.startedAt || nowIso;
    });
    if (!batch.startedAt) batch.startedAt = nowIso;
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const cancelMatch = pathname.match(/^\/batches\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const batch = findBatch(db, cancelMatch[1]);
    if (batch.status !== BATCH_STATUS.OPEN) {
      throw new RuleError("批次已结项或已取消", 409, "batch_not_open");
    }
    const members = db.damages.filter((item) => batch.damageIds.includes(item.id));
    const queued = members.filter((item) => item.status === DAMAGE_STATUS.QUEUED);
    const active = members.filter((item) => item.status === DAMAGE_STATUS.IN_REPAIR);

    // 取消只释放未开工项；在修项不动。全部未开工时批次才整体取消。
    queued.forEach(releaseQueued);
    batch.damageIds = members.filter((item) => item.status !== DAMAGE_STATUS.PENDING).map((item) => item.id);
    if (active.length === 0) {
      batch.status = BATCH_STATUS.CANCELLED;
      batch.cancelledAt = new Date().toISOString();
    }
    await writeDb(db);
    return send(res, 200, {
      data: enrichBatch(db, batch),
      released: queued.map((item) => item.id)
    });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = findBatch(db, completeMatch[1]);
    if (batch.status === BATCH_STATUS.COMPLETED) {
      throw new RuleError("批次已结项，用量已冻结", 409, "batch_completed");
    }
    if (batch.status === BATCH_STATUS.CANCELLED) {
      throw new RuleError("批次已取消，不能结项", 409, "batch_cancelled");
    }
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    const nowIso = new Date().toISOString();

    batch.status = BATCH_STATUS.COMPLETED;
    batch.completedAt = nowIso;
    batch.startedAt = batch.startedAt || nowIso;
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      // 结项冻结用量：状态转 repaired，补纸批次累计占用不再释放。
      freezeRepaired(damage, result, body);
      damage.startedAt = damage.startedAt || nowIso;
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { handle, send, routes };
