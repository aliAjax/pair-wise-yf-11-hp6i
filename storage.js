"use strict";

// 存储层：负责 data/db.json 的读写、历史数据迁移与结果写回。

const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");
const {
  DAMAGE_STATUS,
  QUOTA_OCCUPYING_STATUSES,
  hasFiberProfile
} = require("./rules");

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      grainAngle: 90,
      patchBatchId: "paper_2026_06_a",
      patchDirection: 96,
      createdAt: new Date().toISOString(),
      startedAt: null,
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      grainAngle: 0,
      patchBatchId: "paper_2026_06_a",
      patchDirection: 10,
      createdAt: new Date().toISOString(),
      startedAt: null,
      repairedAt: null
    }
  ],
  batches: []
};

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 历史数据缺纤维登记：补齐字段，缺方向的缺损项按待核验处理，
// 并脱离原修补批次（原归属释放），已有的结项凭证字段保留。
function migrate(db) {
  let changed = false;
  const releasedIds = new Set();

  for (const damage of db.damages) {
    if (!("grainAngle" in damage)) {
      damage.grainAngle = null;
      changed = true;
    }
    if (!("patchBatchId" in damage)) {
      damage.patchBatchId = null;
      changed = true;
    }
    if (!("patchDirection" in damage)) {
      damage.patchDirection = null;
      changed = true;
    }
    if (!("startedAt" in damage)) {
      damage.startedAt =
        damage.status === DAMAGE_STATUS.REPAIRED
          ? damage.repairedAt || damage.createdAt || null
          : damage.status === DAMAGE_STATUS.IN_REPAIR
            ? damage.createdAt || new Date().toISOString()
            : null;
      changed = true;
    }
    if (!hasFiberProfile(damage) && damage.status !== DAMAGE_STATUS.AWAITING_VERIFICATION) {
      damage.status = DAMAGE_STATUS.AWAITING_VERIFICATION;
      if (damage.batchId) releasedIds.add(damage.id);
      damage.batchId = null;
      damage.startedAt = null;
      changed = true;
    }
  }

  if (releasedIds.size) {
    for (const batch of db.batches) {
      const next = batch.damageIds.filter((id) => !releasedIds.has(id));
      if (next.length !== batch.damageIds.length) {
        batch.damageIds = next;
        changed = true;
      }
    }
  }

  return changed;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  // 历史数据迁移结果直接写回现有数据文件。
  if (migrate(db)) {
    await writeFile(DB_FILE, JSON.stringify(db, null, 2));
  }
  return db;
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function enrichBatch(db, batch) {
  const members = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const paperBatchIds = [...new Set(members.map((item) => item.patchBatchId).filter(Boolean))];
  const paperUsage = paperBatchIds.map((patchBatchId) => ({
    patchBatchId,
    used: db.damages.filter(
      (item) => item.patchBatchId === patchBatchId && QUOTA_OCCUPYING_STATUSES.includes(item.status)
    ).length,
    quota: 8
  }));
  const countBy = (status) => members.filter((item) => item.status === status).length;
  return {
    ...batch,
    damages: members,
    total: members.length,
    queued: countBy(DAMAGE_STATUS.QUEUED),
    inRepair: countBy(DAMAGE_STATUS.IN_REPAIR),
    repaired: countBy(DAMAGE_STATUS.REPAIRED),
    pending: members.filter((item) => item.status !== DAMAGE_STATUS.REPAIRED).length,
    paperUsage
  };
}

module.exports = {
  DB_FILE,
  initialData,
  makeId,
  migrate,
  ensureDb,
  readDb,
  writeDb,
  enrichBatch
};
