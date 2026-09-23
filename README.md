# 古籍拓片缺损修补API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化拓片、缺损项和修补批次。

## 启动

```bash
PORT=3020 node server.js
```

## 代码结构（三个业务文件）

| 文件 | 职责 |
| --- | --- |
| `rules.js` | 业务规则：夹角计算、补纸批次额度、整批 409 校验、退回复核/取消释放/结项冻结 |
| `storage.js` | 存储：`data/db.json` 读写、历史数据迁移并写回、批次用量聚合 |
| `routes.js` | 路由：HTTP 解析与业务编排 |
| `server.js` | 仅负责起服务和统一错误响应（409 带 `code`/`details`） |

## 主要接口

- `GET /health`（返回 `fiberAngleLimit=15`、`paperBatchQuota=8`）
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=&patchBatchId=`
- `PATCH /damages/:id`
- `GET /batches` / `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/start` —— 开工（可只开部分 `damageIds`）
- `POST /batches/:id/cancel` —— 取消，只释放未开工项
- `POST /batches/:id/complete` —— 结项，冻结用量

## 补纸纤维方向与批次额度闭环

### 缺损登记三项纤维信息

每个缺损项登记：

- `grainAngle`：原纸纸纹角度，[0, 360) 数值
- `patchDirection`：补纸纤维方向角度，[0, 360) 数值
- `patchBatchId`：补纸批次（库存批次）编号

纤维是无向的，夹角取 `min(|Δ|, 180-|Δ|)`，范围 [0, 90]。

### 建批整批校验（409，原归属与状态不变）

`POST /batches` 对全部候选项做整批校验，任一不通过则整批拒绝、不写库：

1. **夹角超限**：某项纸纹角度与补纸方向夹角 **> 15°** → `409 fiber_angle_mismatch`，明细在 `details.failures`。
2. **补纸批次额度**：同一 `patchBatchId` 累计占用（已排单 + 在修 + 已结项）**超过 8 项** → `409 paper_batch_quota_exceeded`，明细含 `current/additions/quota`。
3. 缺损项必须是未归属的 `pending` 状态，否则 `409 damage_unavailable`。

建批成功后缺损项为 `queued`（已占额、未开工）。`POST /batches/:id/start` 开工时会对未开工项再过一次夹角与额度闸口，防止排单后数据被改。

### 开工后变更 → 退回待复核并释放占用

已开工（`in_repair`）的缺损项一旦修改 `grainAngle` 或 `patchDirection`（含换 `patchBatchId`）：

- 状态变为 `awaiting_review`；
- `batchId`/`startedAt` 清空（脱离修补批次，同时从该批次成员中移除）；
- 对补纸批次额度的占用立即释放。

复核通过：`PATCH /damages/:id` 改数据后显式 `{"status":"pending"}`，夹角仍超 15° 会以 409 拒绝复核。

### 取消与结项

- `POST /batches/:id/cancel`：**只释放未开工（queued）项**回 `pending`；在修项不动。全部成员都未开工时批次才标记 `cancelled`，仍有在修项时批次保持 `open`。
- `POST /batches/:id/complete`：成员转 `repaired`，**用量冻结**——结项后仍计入补纸批次累计，纤维方向、补纸批次与状态不可再改（仅备注/照片可补，违反返回 `409 repair_frozen`）。

### 状态一览

`pending`（待排单）→ `queued`（已占额未开工）→ `in_repair`（已开工）→ `repaired`（已结项冻结）；旁路：`awaiting_verification`（历史缺方向，待核验）、`awaiting_review`（开工后变更，待复核）。

### 历史数据

旧数据缺少纤维字段时，服务首次读取即迁移并**写回现有 `data/db.json`**：补齐 `grainAngle/patchDirection/patchBatchId/startedAt` 字段，缺方向的缺损项按 **`awaiting_verification`（待核验）** 处理并脱离原批次；后续在 `PATCH` 中补齐三项且夹角 ≤ 15° 即自动回到 `pending`。

## 闭环示例

```bash
# 登记缺损（含纸纹角度、补纸批次、补纸方向）
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/damages \
  -H 'Content-Type: application/json' \
  -d '{"position":"左上角","type":"虫蛀孔","beforePhotoUrl":"https://example.local/a.jpg",
       "grainAngle":90,"patchBatchId":"paper_2026_06_a","patchDirection":96}'

# 建批（夹角>15° 或同补纸批次累计>8项 → 409，原数据不变）
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1"]}'

# 开工 / 取消（只放未开工项）/ 结项（冻结用量）
curl -X POST http://127.0.0.1:3020/batches/<id>/start
curl -X POST http://127.0.0.1:3020/batches/<id>/cancel
curl -X POST http://127.0.0.1:3020/batches/<id>/complete \
  -H 'Content-Type: application/json' -d '{"results":[{"damageId":"damage_demo_1","afterPhotoUrl":"https://example.local/after.jpg"}]}'
```
