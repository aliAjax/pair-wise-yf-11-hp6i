"use strict";

// 补纸纤维方向与批次额度闭环的业务规则（纯函数，不碰持久化与 HTTP）。

const FIBER_ANGLE_LIMIT = 15; // 纸纹角度与补纸方向夹角上限（度）
const PAPER_BATCH_QUOTA = 8; // 同一补纸批次最多占用项数

const DAMAGE_STATUS = Object.freeze({
  PENDING: "pending", // 待排单
  QUEUED: "queued", // 已入批，未开工
  IN_REPAIR: "in_repair", // 已开工
  REPAIRED: "repaired", // 已结项，用量冻结
  AWAITING_VERIFICATION: "awaiting_verification", // 历史数据缺方向，待核验
  AWAITING_REVIEW: "awaiting_review" // 开工后角度/方向变化，退回复核
});

const BATCH_STATUS = Object.freeze({
  OPEN: "open",
  COMPLETED: "completed",
  CANCELLED: "cancelled"
});

class RuleError extends Error {
  constructor(message, status = 400, code = "bad_request", details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// 纤维是无向的：0° 与 180° 同向，夹角落在 [0, 90]。
function degreeIncludedAngle(a, b) {
  const diff = Math.abs(Number(a) - Number(b)) % 180;
  const acute = diff > 90 ? 180 - diff : diff;
  return Math.round(acute * 100) / 100;
}

function asAngle(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num >= 360) {
    throw new RuleError(`${field}必须是 [0, 360) 之间的角度数值`, 400, "invalid_angle");
  }
  return num;
}

function hasFiberProfile(damage) {
  return (
    Number.isFinite(Number(damage.grainAngle)) &&
    typeof damage.patchBatchId === "string" &&
    damage.patchBatchId !== "" &&
    Number.isFinite(Number(damage.patchDirection))
  );
}

function fiberAngleGap(damage) {
  return degreeIncludedAngle(damage.grainAngle, damage.patchDirection);
}

// 占用补纸批次额度的状态：已排单、在修（释放前）、已结项（冻结）。
// 待核验/待复核/待排单不占用；取消与退回复核会释放占用。
const QUOTA_OCCUPYING_STATUSES = Object.freeze([
  DAMAGE_STATUS.QUEUED,
  DAMAGE_STATUS.IN_REPAIR,
  DAMAGE_STATUS.REPAIRED
]);

function countPaperBatchUsage(db, patchBatchId) {
  return db.damages.filter(
    (item) => item.patchBatchId === patchBatchId && QUOTA_OCCUPYING_STATUSES.includes(item.status)
  ).length;
}

function assertPaperBatchQuota(db, patchBatchId, additions, selfIds = []) {
  const current = db.damages.filter(
    (item) =>
      item.patchBatchId === patchBatchId &&
      QUOTA_OCCUPYING_STATUSES.includes(item.status) &&
      !selfIds.includes(item.id)
  ).length;
  if (current + additions > PAPER_BATCH_QUOTA) {
    throw new RuleError(
      `补纸批次 ${patchBatchId} 累计将达 ${current + additions} 项，超过额度 ${PAPER_BATCH_QUOTA} 项，整批退回`,
      409,
      "paper_batch_quota_exceeded",
      { patchBatchId, current, additions, quota: PAPER_BATCH_QUOTA }
    );
  }
}

// 开工前（建批 / 开工）对候选缺损项做纤维与额度整批校验。
// 任一项不通过都抛 409，由调用方保证不写库（原归属与状态不变）。
// allowedStatuses：建批只收 pending（未归属），开工只收 queued（未开工）。
function assertFiberBatch(db, candidates, allowedStatuses = [DAMAGE_STATUS.PENDING, DAMAGE_STATUS.QUEUED]) {
  const angleFailures = [];
  const unavailable = [];
  for (const damage of candidates) {
    if (!allowedStatuses.includes(damage.status)) {
      unavailable.push({ damageId: damage.id, status: damage.status });
      continue;
    }
    if (!hasFiberProfile(damage)) {
      angleFailures.push({ damageId: damage.id, reason: "fiber_profile_missing" });
      continue;
    }
    const gap = fiberAngleGap(damage);
    if (gap > FIBER_ANGLE_LIMIT) {
      angleFailures.push({ damageId: damage.id, grainAngle: damage.grainAngle, patchDirection: damage.patchDirection, gap });
    }
  }
  if (unavailable.length) {
    throw new RuleError("存在当前不可排单/开工的缺损项", 409, "damage_unavailable", { unavailable });
  }
  if (angleFailures.length) {
    throw new RuleError(
      `存在纸纹与补纸方向夹角超过 ${FIBER_ANGLE_LIMIT}° 的缺损项，整批退回`,
      409,
      "fiber_angle_mismatch",
      { limit: FIBER_ANGLE_LIMIT, failures: angleFailures }
    );
  }

  const additionsByPaperBatch = new Map();
  for (const damage of candidates) {
    additionsByPaperBatch.set(damage.patchBatchId, (additionsByPaperBatch.get(damage.patchBatchId) || 0) + 1);
  }
  // 已在同一修补批次内（重开工场景）的项不重复计额。
  const selfIds = candidates.map((item) => item.id);
  for (const [patchBatchId, additions] of additionsByPaperBatch) {
    assertPaperBatchQuota(db, patchBatchId, additions, selfIds);
  }
}

// 开工后角度或方向变化：该项退回待复核并释放占用（脱离修补批次、释放补纸额度）。
function releaseToReview(damage) {
  damage.status = DAMAGE_STATUS.AWAITING_REVIEW;
  damage.batchId = null;
  damage.startedAt = null;
  damage.repairedAt = null;
}

// 取消只释放未开工项（queued）；在修与已结项不受影响。
function releaseQueued(damage) {
  damage.status = DAMAGE_STATUS.PENDING;
  damage.batchId = null;
  damage.startedAt = null;
}

// 结项：冻结用量（repaired 仍计入补纸批次累计）。
function freezeRepaired(damage, result = {}, fallback = {}) {
  damage.status = DAMAGE_STATUS.REPAIRED;
  damage.afterPhotoUrl = result.afterPhotoUrl || fallback.defaultAfterPhotoUrl || damage.afterPhotoUrl;
  damage.repairNote = result.repairNote || fallback.defaultRepairNote || damage.repairNote;
  damage.repairedAt = new Date().toISOString();
  // 纤维登记与补纸批次归属保持不变，作为冻结用量凭证。
}

function isFiberField(field) {
  return field === "grainAngle" || field === "patchDirection" || field === "patchBatchId";
}

module.exports = {
  FIBER_ANGLE_LIMIT,
  PAPER_BATCH_QUOTA,
  DAMAGE_STATUS,
  BATCH_STATUS,
  QUOTA_OCCUPYING_STATUSES,
  RuleError,
  asAngle,
  degreeIncludedAngle,
  hasFiberProfile,
  fiberAngleGap,
  countPaperBatchUsage,
  assertPaperBatchQuota,
  assertFiberBatch,
  releaseToReview,
  releaseQueued,
  freezeRepaired,
  isFiberField
};
