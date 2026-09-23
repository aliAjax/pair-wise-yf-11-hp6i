// 补纸纤维方向与批次额度闭环：纯业务规则，不涉及 HTTP 与文件读写。

const ANGLE_LIMIT_DEG = 15; // 纸纹角度与补纸方向允许的最大夹角
const PAPER_BATCH_LIMIT = 8; // 同一补纸批次累计最多占用八项

// 占用补纸批次额度的缺损状态：已开工（占用中）与已结项（冻结用量）
const OCCUPYING_STATUSES = ["in_repair", "repaired"];

class RuleError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// 角度归一到 [0, 360)
function normalizeAngle(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new RuleError(400, `${field}必须是数字（单位：度）`);
  }
  return ((num % 360) + 360) % 360;
}

function requirePaperBatchId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuleError(400, "补纸批次不能为空");
  }
  return value.trim();
}

// 两个方向角之间的最小圆周夹角，结果落在 [0, 180]
function angleDifference(a, b) {
  const diff = Math.abs(Number(a) - Number(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function isAligned(damage) {
  if (damage.grainAngle == null || damage.repairDirection == null) return null;
  return angleDifference(damage.grainAngle, damage.repairDirection) <= ANGLE_LIMIT_DEG;
}

function decorateDamage(damage) {
  const angleDiff =
    damage.grainAngle == null || damage.repairDirection == null
      ? null
      : angleDifference(damage.grainAngle, damage.repairDirection);
  return {
    ...damage,
    angleDiff,
    aligned: angleDiff == null ? null : angleDiff <= ANGLE_LIMIT_DEG
  };
}

// 当前已占用同一补纸批次额度的数量（已开工 + 已结项冻结）
function paperBatchUsage(db) {
  const usage = new Map();
  for (const damage of db.damages) {
    if (!damage.paperBatchId || !OCCUPYING_STATUSES.includes(damage.status)) continue;
    usage.set(damage.paperBatchId, (usage.get(damage.paperBatchId) || 0) + 1);
  }
  return usage;
}

// 开工前整批校验：任一缺损夹角超限或补纸批次累计超八项，整批驳回。
// 只做校验、不改数据，由路由在全部通过后统一落库，保证“原归属与状态不变”。
function validateStartBatch(db, damageIds) {
  const violations = [];
  const startable = [];

  for (const damageId of damageIds) {
    const damage = db.damages.find((item) => item.id === damageId);
    if (!damage) {
      throw new RuleError(400, `缺损项不存在：${damageId}`);
    }
    if (damage.status === "unverified") {
      violations.push({ type: "unverified", damageId });
      continue;
    }
    if (damage.status !== "pending") {
      violations.push({ type: "not_pending", damageId, status: damage.status });
      continue;
    }
    if (damage.grainAngle == null || damage.repairDirection == null || !damage.paperBatchId) {
      violations.push({ type: "unverified", damageId });
      continue;
    }
    const diff = angleDifference(damage.grainAngle, damage.repairDirection);
    if (diff > ANGLE_LIMIT_DEG) {
      violations.push({
        type: "angle",
        damageId,
        grainAngle: damage.grainAngle,
        repairDirection: damage.repairDirection,
        angleDiff: Number(diff.toFixed(4)),
        limit: ANGLE_LIMIT_DEG
      });
      continue;
    }
    startable.push(damage);
  }

  // 按补纸批次汇总：既有占用 + 本批拟新增
  const usage = paperBatchUsage(db);
  const adding = new Map();
  for (const damage of startable) {
    adding.set(damage.paperBatchId, (adding.get(damage.paperBatchId) || 0) + 1);
  }
  for (const [paperBatchId, addCount] of adding) {
    const used = usage.get(paperBatchId) || 0;
    if (used + addCount > PAPER_BATCH_LIMIT) {
      violations.push({
        type: "quota",
        paperBatchId,
        used,
        adding: addCount,
        total: used + addCount,
        limit: PAPER_BATCH_LIMIT
      });
    }
  }

  if (violations.length) {
    throw new RuleError(409, "开工校验未通过，整批驳回，原归属与状态不变", { violations });
  }
  return startable;
}

// 取消只释放未开工项；已开工、已结项的占用不释放
function assertCancelable(damage) {
  if (damage.status === "in_repair") {
    throw new RuleError(409, "缺损项已开工，不能取消，占用不释放");
  }
  if (damage.status === "repaired") {
    throw new RuleError(409, "缺损项已结项，用量已冻结");
  }
  if (damage.status === "cancelled") {
    throw new RuleError(409, "缺损项已取消");
  }
}

function isFrozen(damage) {
  return damage.status === "repaired" || damage.status === "cancelled";
}

// 结项时按补纸批次冻结实际用量
function freezePaperUsage(db, damageIds) {
  const frozen = new Map();
  for (const damage of db.damages) {
    if (!damageIds.includes(damage.id) || damage.status !== "repaired" || !damage.paperBatchId) continue;
    frozen.set(damage.paperBatchId, (frozen.get(damage.paperBatchId) || 0) + 1);
  }
  return Object.fromEntries(frozen);
}

module.exports = {
  ANGLE_LIMIT_DEG,
  PAPER_BATCH_LIMIT,
  OCCUPYING_STATUSES,
  RuleError,
  normalizeAngle,
  requirePaperBatchId,
  angleDifference,
  isAligned,
  decorateDamage,
  paperBatchUsage,
  validateStartBatch,
  assertCancelable,
  isFrozen,
  freezePaperUsage
};
