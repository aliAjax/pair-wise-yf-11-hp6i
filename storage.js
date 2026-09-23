// 数据持久化：读写现有 data/db.json，并对历史数据做补纸字段迁移。

const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date("2026-06-16T00:00:00.000Z").toISOString()
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
      repairDirection: 88,
      paperBatchId: "PAPER-2026-A01",
      createdAt: "2026-06-16T00:00:00.000Z",
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
      repairDirection: 12,
      paperBatchId: "PAPER-2026-A01",
      createdAt: "2026-06-16T00:00:00.000Z",
      repairedAt: null
    }
  ],
  batches: []
};

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

// 历史缺损项没有纸纹角度、补纸方向、补纸批次字段：
// 未结束的一律转为 unverified（待核验），补齐方向信息后才能开工。
function migrate(data) {
  let changed = false;
  for (const damage of data.damages) {
    if (damage.grainAngle === undefined) {
      damage.grainAngle = null;
      changed = true;
    }
    if (damage.repairDirection === undefined) {
      damage.repairDirection = null;
      changed = true;
    }
    if (damage.paperBatchId === undefined) {
      damage.paperBatchId = null;
      changed = true;
    }
    const lacksDirection = damage.grainAngle == null || damage.repairDirection == null || !damage.paperBatchId;
    if (lacksDirection && ["pending", "review_pending"].includes(damage.status)) {
      damage.status = "unverified";
      changed = true;
    }
  }
  for (const batch of data.batches) {
    if (batch.frozenPaperUsage === undefined) {
      batch.frozenPaperUsage = null;
      changed = true;
    }
  }
  return changed;
}

async function readDb() {
  await ensureDb();
  const data = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (migrate(data)) await writeDb(data);
  return data;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { DB_FILE, readDb, writeDb, makeId, migrate };
