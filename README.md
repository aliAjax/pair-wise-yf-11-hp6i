# 古籍拓片缺损修补API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化拓片、缺损项和修补批次。

## 启动

```bash
PORT=3020 node server.js
```

代码按职责拆分：

- `rules.js`：补纸纤维方向与批次额度闭环规则（夹角、额度、取消/冻结判定）
- `storage.js`：`data/db.json` 读写、ID 生成、历史数据迁移
- `routes.js`：HTTP 路由与请求处理
- `server.js`：服务装配入口

## 接口

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=&paperBatchId=&batchId=`
- `PATCH /damages/:id`
- `POST /damages/:id/cancel`
- `GET /batches` / `POST /batches`
- `GET /batches/:id`
- `POST /batches/:id/complete`

## 缺损登记（补纸三要素）

每个缺损项必须登记：

- `grainAngle`：缺损处原纸纸纹角度（度，0–360）
- `repairDirection`：补纸铺设方向（度，0–360）
- `paperBatchId`：补纸批次号（同一补纸纸张批次）

登记后状态为 `pending`（待开工）。缺损响应中附带 `angleDiff`（两方向最小圆周夹角）与 `aligned`（是否在允许夹角内）。

历史数据若缺少角度、方向或补纸批次，读取时自动迁移为 `unverified`（待核验）；通过 `PATCH` 补齐三项后，再显式 `PATCH {"status":"pending"}` 方可开工。

## 开工闭环（POST /batches）

整批原子校验，先校验后落库，任一不过整批返回 **409**，原归属与状态不变：

1. **夹角规则**：`min(|grainAngle - repairDirection|, 360 - |...|) > 15°` 不允许开工。
2. **批次额度**：同一 `paperBatchId` 当前占用数（已开工 + 已结项）加本批拟新增数超过 **8 项** 不允许开工。
3. 非待开工状态（`unverified`、`review_pending`、已在其他批次）同样驳回。

409 响应体的 `details.violations` 列出全部违规项（`angle` / `quota` / `unverified` / `not_pending`）。

## 开工后的调整

- `PATCH /damages/:id` 修改开工项的 `grainAngle` 或 `repairDirection`：该项自动退回 `review_pending`（待复核），移出工作批次并释放补纸批次额度占用。
- 开工项不允许更换 `paperBatchId`（409），也不允许直接改状态。
- 待复核项补齐方向后，`PATCH {"status":"pending"}` 复核通过，回到待开工。

## 取消与结项

- `POST /damages/:id/cancel`：**仅释放未开工项**（`pending`/`unverified`/`review_pending`）；已开工返回 409 占用不释放，已结项返回 409 用量已冻结。
- `POST /batches/:id/complete`：批次结项，各项转为 `repaired`，批次记录 `frozenPaperUsage` 冻结各补纸批次实际用量；已结项的缺损不可再修改角度、方向与批次。

## 闭环示例

```bash
# 登记缺损（含纸纹角度、补纸方向、补纸批次）
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/damages \
  -H 'Content-Type: application/json' \
  -d '{"position":"右侧残缺口","type":"残缺","beforePhotoUrl":"https://example.local/b.jpg",
       "grainAngle":90,"repairDirection":85,"paperBatchId":"PAPER-2026-A02"}'

# 整批开工（夹角/额度通过才占用，否则 409 且不变更任何数据）
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"九月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 开工后发现方向需修正：该项退回待复核并释放占用
curl -X PATCH http://127.0.0.1:3020/damages/damage_demo_1 \
  -H 'Content-Type: application/json' \
  -d '{"repairDirection":60}'

# 未开工项取消；结项冻结用量
curl -X POST http://127.0.0.1:3020/damages/damage_demo_2/cancel
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete
```
