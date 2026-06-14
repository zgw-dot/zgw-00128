# 冷链样本入库出库追踪系统

基于 Node.js + Express + SQLite 的轻量级冷链样本全生命周期追踪管理系统。

---

## 功能特性

- **样本管理**: 登记样本批次、条码、名称、要求温区
- **全流程操作**: 入库 → 转移 → 出库 / 报废，每步自动记录时间线
- **温控异常**: 随时记录温度异常情况，永久留存
- **业务校验**: 严格拦截非法操作（见下方非法场景列表）
- **温区库位配置**: 温区温度范围、库位容量均可自由配置并持久化
- **台账预警**: 风险样本、温区不匹配、温控异常、库位容量监控
- **批量导入导出**: CSV 格式批量登记样本
- **条码追踪**: 按条码查询，追踪历史永不丢失（SQLite 持久化）
- **🔍 盘点和纠错**: 按温区或库位发起盘点，导入扫码CSV自动比对，标出多扫、漏扫、库位不一致、已出库样本被扫等差异
- **📊 差异处理**: 支持导出盘点结果，差异处理记录操作人、时间、原因和前后状态
- **👥 角色权限控制**: 普通库管只能提交盘点和异常说明，管理员才能确认纠错、撤销操作
- **↩️ 操作撤销**: 支持撤销未出库的错误转移或报废动作，不抹掉原时间线，追加反向记录并恢复库位或状态
- **📜 完整历史查询**: 按条码、批次、盘点单号查询完整历史，重启后数据不丢失

---

## 预置账号（登录请用）

| 用户名 | 密码 | 角色 | 权限说明 |
|--------|------|------|----------|
| `admin` | `admin123` | **管理员** | 所有操作：样本CRUD、盘点、差异处理、操作撤销 |
| `warehouse` | `wh123` | **库管员** | 样本入库/转移/出库、发起盘点、**不能处理差异、不能撤销** |
| `viewer` | `view123` | **只读用户** | 只能查看，不能做任何修改 |

---

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
npm start
```

启动后访问: **http://localhost:3000**

---

## 一键验收（三条命令覆盖所有场景）

如果只想验证功能完整性，不需要手动操作，直接在三个终端里依次执行：

```bash
# ========== 第1条 ==========
# 终端1：启动服务（保持打开，Ctrl+C 停止）
npm start
# 等待出现"冷链样本追踪系统已启动: http://localhost:3000"

# ========== 第2条 ==========
# 终端2：连续跑两遍完整测试（验证稳定性 + 不依赖清空数据）
node test.js ; node test.js
# 预期结果：21 通过, 0 失败  × 2 遍

# ========== 第3条 ==========
# 终端3：回到终端1，Ctrl+C 停掉服务，再重新启动 npm start
# 然后终端2执行：
node test-restart.js
# 预期结果：10 通过, 0 失败（验证重启后所有数据保留）
```

以上三条全通过即可验收 ✅。下面是手动操作步骤。

---

## 页面操作复现步骤（手动验收）

所有操作都在浏览器 **http://localhost:3000** 里完成。

### 1. 登录（角色：管理员 admin）

1. 打开首页，右上点「登录」
2. 用户名：`admin`，密码：`admin123`
3. 登录成功右上角显示用户名和角色标签

### 2. 准备样本（创建 + 入库）

1. 点击左侧「样本管理」→「➕ 新增样本」
2. 依次新增 **5 个样本**（建议条码取个唯一前缀，比如 `验收-MMDD-S1` ~ `验收-MMDD-S5`，MMDD是今天月日）：

| 条码（示例） | 批次 | 名称 | 要求温区 |
|-----------|------|------|----------|
| `验收-0614-S1` | `BATCH-验收-0614` | 血清样本-1 | 冷藏(2-8℃) |
| `验收-0614-S2` | `BATCH-验收-0614` | 血清样本-2 | 冷藏(2-8℃) |
| `验收-0614-S3` | `BATCH-验收-0614` | 血清样本-3 | 冷藏(2-8℃) |
| `验收-0614-S4` | `BATCH-验收-0614` | 血清样本-4 | 冷藏(2-8℃) |
| `验收-0614-S5` | `BATCH-验收-0614` | 血清样本-5 | 冷藏(2-8℃) |

3. 对 5 个样本依次点「详情」→「入库」→ 库位选 `R-A1`（冷藏区）→ 提交
   （预期：状态从「待入库」→「在库」）
4. 对 **S3** 点「转移」→ 目标库位选 `R-A2` → 提交
   （预期：S3 当前位置变为 R-A2，制造后面盘点的「库位不一致」）
5. 对 **S5** 点「出库」→ 填备注「用完」→ 提交
   （预期：S5 状态变为「已出库」，制造后面盘点的「已出库样本被扫到」）

### 3. 创建盘点单 + 导入扫码CSV（制造冲突）

1. 点击左侧「盘点管理」→「➕ 新建盘点单」
2. 标题：`验收盘点-0614`，盘点范围选「库位」→ 选 `R-A1`（冷藏A1库位）
3. 创建后进入盘点详情页，点「📥 导入扫码CSV」，**粘贴**下面内容：

   ```csv
   条码,库位,扫描时间
   验收-0614-S1,R-A1,2024-06-15 09:00:00
   验收-0614-S2,R-A1,2024-06-15 09:01:00
   验收-0614-S3,R-A1,2024-06-15 09:02:00
   验收-0614-S5,R-A1,2024-06-15 09:03:00
   验收-0614-EXTRA,R-A1,2024-06-15 09:04:00
   ```

   > 故意制造5种场景：
   > - ✅ S1、S2：正常匹配
   > - ⚠️ S3：台账在 **R-A2**，但扫码在 **R-A1** → **库位不一致**
   > - ⚠️ S5：已出库样本却被扫到 → **已出库被扫**
   > - ⚠️ EXTRA：台账根本没这个样本 → **多扫（补登）**
   > - ⚠️ S4：台账在 R-A1 但没扫到 → **漏扫**

4. 导入后看「差异列表」，5 类差异应该都能看到。

### 4. 差异处理：权限验证 + 纠错（管理员）

1. **先测权限拦截**：
   - 右上角点「退出」→ 用 `warehouse` / `wh123`（库管员）登录
   - 回到盘点详情页，点任一条差异的「处理」按钮
   - **预期：被拒绝，提示「需要管理员权限」**
   - 但库管员可以点差异右侧「➕ 备注」，写说明，**预期：保存成功**
2. **管理员处理差异**：
   - 再退出，重新用 `admin` / `admin123` 登录
   - 回到盘点详情页，对 4 个主要差异逐一处理：

   | 差异类型 | 样本 | 处理动作 | 填写内容 |
   |---------|------|----------|----------|
   | 库位不一致 | S3 | 纠正位置 | 选 `R-A1`（相信扫码，调整台账到 R-A1），理由：扫描确认在R-A1 |
   | 已出库被扫 | S5 | 忽略 | 理由：旧标签未撕，已核实已出库 |
   | 多扫 | EXTRA | 补登样本 | 批次填 `BATCH-验收-0614-补登`，名称：临时样本，理由：遗漏登记 |
   | 漏扫 | S4 | 忽略 | 理由：S4借出在途，下次入库再盘 |

   处理完后，所有差异状态变为「已解决」，显示处理人和处理时间。

### 5. 导出盘点结果

- 盘点详情页点「📤 导出CSV」→ 下载 `inventory_result.csv`
- 打开看，所有样本状态、扫描情况、差异处理记录全在里面

### 6. 操作撤销：转移 / 报废（管理员）

1. 回到样本详情页，找 **S1**（状态应为「在库」，位置R-A1）：
   - 点「转移」→ 选 `R-A2` → 提交（故意转错）
   - 现在位置变成 R-A2
   - 滚动到时间线底部，点「↩️ 可撤销操作」→ 对刚才那条转移点「撤销」→ 填理由：操作失误
   - **预期：位置回到 R-A1，时间线追加一条「撤销转移」，原转移记录不删**
   - 再点「出库」→ 正常出库（验证撤销后状态完好）
2. 再找一个样本（或新建一个叫 `验收-0614-SCRAP` 的）：
   - 入库到 R-A1
   - 点「报废」→ 填理由：过期
   - **预期：状态变「已报废」**
   - 时间线底部「↩️ 可撤销操作」→ 对报废点「撤销」→ 填理由：还能用
   - **预期：状态回「在库」，位置还是 R-A1**

### 7. 历史查询（三种方式）

1. **按条码查**：
   - 左侧「历史查询」→ 查询类型选「条码」→ 输入 `验收-0614-S3`
   - **预期：看到登记、入库、转移、盘点纠错 4 条以上时间线，以及 1 条库位不一致差异记录**
2. **按批次查**：
   - 查询类型选「批次」→ 输入 `BATCH-验收-0614`
   - **预期：S1~S5 共 5 个样本都在**
3. **按盘点单号查**：
   - 回到盘点详情页，顶部有一串形如 `PD202406150001` 的号，复制
   - 历史查询里选「盘点单号」→ 粘贴那串号
   - **预期：这次盘点涉及的所有样本 + 差异列表**

### 8. 重启持久化验证

1. 把刚才操作的条码记下来（例如 `验收-0614-S3`）
2. 终端里 `npm start` 那个窗口按 **Ctrl+C** 停止服务
3. 再执行 `npm start` 重启
4. 浏览器刷新，重新登录 admin
5. 按条码查 `验收-0614-S3`
6. **预期：状态、位置、所有时间线、差异记录和重启前完全一样**

---

## 目录结构

```
├── server.js          # 后端服务 + API 路由 + 业务校验
├── db.js              # SQLite 数据库初始化与连接
├── test.js            # 自动验收测试（21个用例，RUN_ID唯一生成，可重复跑N次）
├── test-restart.js    # 重启后持久化验证（读 test-state.json）
├── test-state.json    # （运行时生成）保存上一次测试的条码/ID，供重启验证读取
├── package.json       # 项目配置
├── data/              # SQLite 数据库文件目录（自动创建）
│   └── tracker.db     # 持久化数据文件（重启不丢失）
└── public/
    └── index.html     # 前端单页管理界面
```

---

## API 接口列表（可直接用 curl 验证）

所有接口统一返回格式：`{ success: boolean, data?: any, error?: string, forbidden?: true }`

> ⚠️ **curl 会话说明**：服务器用 cookie-session，所以登录后要**保存 cookie**。
> 下面示例统一用 `-c cookies.txt` 写 cookie、`-b cookies.txt` 读 cookie。
>
> Windows PowerShell 用户：直接复制即可（换行用反引号 `\`` 或写一行）。
> CMD 用户：换行用 `^`。

### 0. 公共工具：温区/库位（获取 ID 用）

先拿库位 ID，后面创建样本、入库都要用：

```bash
# 先登录（管理员）
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"username\":\"admin\",\"password\":\"admin123\"}"

# 查所有库位（找到 code=R-A1 的 id，通常是 1；R-A2 通常是 2）
curl -b cookies.txt http://localhost:3000/api/locations
```

### 1. 样本全流程（登记→入库→转移→出库）

```bash
# 1.1 登记 5 个样本（返回的 data.id 存好，后面用 $SID1 代替）
curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/samples ^
  -H "Content-Type: application/json" ^
  -d "{\"barcode\":\"验收-S1\",\"batch_no\":\"BATCH-验收\",\"name\":\"血清S1\",\"required_zone_id\":1}"
# ↑ 重复 5 次，分别改成 S1~S5，保存每次返回的 id

# 1.2 入库（假设 location_id=1，就是 R-A1）
curl -b cookies.txt -X POST http://localhost:3000/api/samples/$SID1/inbound ^
  -H "Content-Type: application/json" ^
  -d "{\"location_id\":1,\"remark\":\"入库\"}"
# ↑ 对 S1~S5 都做一次

# 1.3 转移 S3 到 R-A2（location_id=2）
curl -b cookies.txt -X POST http://localhost:3000/api/samples/$SID3/transfer ^
  -H "Content-Type: application/json" ^
  -d "{\"to_location_id\":2,\"remark\":\"整理库位\"}"

# 1.4 出库 S5
curl -b cookies.txt -X POST http://localhost:3000/api/samples/$SID5/outbound ^
  -H "Content-Type: application/json" ^
  -d "{\"remark\":\"用完\"}"
```

### 2. 盘点管理

```bash
# 2.1 创建盘点单（按库位 location_id=1，即 R-A1）
curl -b cookies.txt -X POST http://localhost:3000/api/inventory ^
  -H "Content-Type: application/json" ^
  -d "{\"title\":\"API验收盘点\",\"type\":\"location\",\"location_id\":1}"
# ↑ 返回的 data.id 就是盘点单 ID，记为 $INV_ID

# 2.2 导入扫码 CSV（制造 5 种冲突）
curl -b cookies.txt -X POST http://localhost:3000/api/inventory/$INV_ID/import ^
  -H "Content-Type: application/json" ^
  -d "{\"rows\":[
    {\"barcode\":\"验收-S1\",\"location\":\"R-A1\",\"scan_time\":\"2024-06-15 09:00:00\"},
    {\"barcode\":\"验收-S2\",\"location\":\"R-A1\",\"scan_time\":\"2024-06-15 09:01:00\"},
    {\"barcode\":\"验收-S3\",\"location\":\"R-A1\",\"scan_time\":\"2024-06-15 09:02:00\"},
    {\"barcode\":\"验收-S5\",\"location\":\"R-A1\",\"scan_time\":\"2024-06-15 09:03:00\"},
    {\"barcode\":\"验收-EXTRA\",\"location\":\"R-A1\",\"scan_time\":\"2024-06-15 09:04:00\"}
  ]}"

# 2.3 看盘点详情 + 差异统计
curl -b cookies.txt http://localhost:3000/api/inventory/$INV_ID

# 2.4 导出盘点结果 CSV
curl -b cookies.txt -o inventory_result.csv http://localhost:3000/api/inventory/$INV_ID/export/csv
```

### 3. 差异处理（先测权限拦截，再处理）

先拿到差异 ID（从上面 2.3 的返回里找 discrepancies 数组，每个有 id 和 type）：

```bash
# 3.1 切换到库管员（会覆盖 cookies.txt）
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"username\":\"warehouse\",\"password\":\"wh123\"}"

# 3.2 库管员尝试处理差异 → 预期被拒（forbidden=true）
curl -b cookies.txt -X POST http://localhost:3000/api/discrepancies/$DISP_ID_MISLOCATED/resolve ^
  -H "Content-Type: application/json" ^
  -d "{\"action\":\"correct_location\",\"new_location_id\":1,\"remark\":\"尝试处理\"}"
# ↑ 返回: { success: false, error: "需要管理员权限", forbidden: true }

# 3.3 但库管员可以加备注
curl -b cookies.txt -X POST http://localhost:3000/api/discrepancies/$DISP_ID_MISLOCATED/note ^
  -H "Content-Type: application/json" ^
  -d "{\"note\":\"确实放错了\"}"

# 3.4 切回管理员
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"username\":\"admin\",\"password\":\"admin123\"}"

# 3.5 管理员处理库位不一致（S3）
curl -b cookies.txt -X POST http://localhost:3000/api/discrepancies/$DISP_ID_MISLOCATED/resolve ^
  -H "Content-Type: application/json" ^
  -d "{\"action\":\"correct_location\",\"new_location_id\":1,\"remark\":\"扫码确认在R-A1\"}"

# 3.6 管理员处理多扫（补登记样本）
curl -b cookies.txt -X POST http://localhost:3000/api/discrepancies/$DISP_ID_EXTRA/resolve ^
  -H "Content-Type: application/json" ^
  -d "{\"action\":\"register_extra\",\"batch_no\":\"BATCH-验收-补登\",\"name\":\"临时样本\",\"remark\":\"遗漏登记补登\"}"

# 3.7 管理员处理漏扫（忽略）
curl -b cookies.txt -X POST http://localhost:3000/api/discrepancies/$DISP_ID_MISSING/resolve ^
  -H "Content-Type: application/json" ^
  -d "{\"action\":\"ignore\",\"remark\":\"借出在途\"}"

# 3.8 管理员处理已出库被扫（忽略）
curl -b cookies.txt -X POST http://localhost:3000/api/discrepancies/$DISP_ID_OUTBOUND/resolve ^
  -H "Content-Type: application/json" ^
  -d "{\"action\":\"ignore\",\"remark\":\"旧标签没撕\"}"
```

### 4. 操作撤销（管理员）

```bash
# 4.1 查可撤销的操作（拿 timelineId）
curl -b cookies.txt http://localhost:3000/api/samples/$SID1/reversable-actions

# 4.2 撤销转移
curl -b cookies.txt -X POST http://localhost:3000/api/samples/$SID1/reverse/$TIMELINE_ID_TRANSFER ^
  -H "Content-Type: application/json" ^
  -d "{\"reason\":\"操作失误\"}"

# 4.3 撤销后再出库（验证状态正常）
curl -b cookies.txt -X POST http://localhost:3000/api/samples/$SID1/outbound ^
  -H "Content-Type: application/json" ^
  -d "{\"remark\":\"撤销后正常使用完毕\"}"

# --- 撤销报废演示 ---
# 4.4 新建一个报废样本
curl -b cookies.txt -X POST http://localhost:3000/api/samples ^
  -H "Content-Type: application/json" ^
  -d "{\"barcode\":\"验收-SCRAP\",\"batch_no\":\"BATCH-验收-SCRAP\",\"name\":\"要报废的\",\"required_zone_id\":1}"
# 入库
curl -b cookies.txt -X POST http://localhost:3000/api/samples/$SCRAP_ID/inbound ^
  -H "Content-Type: application/json" ^
  -d "{\"location_id\":1}"
# 报废
curl -b cookies.txt -X POST http://localhost:3000/api/samples/$SCRAP_ID/scrap ^
  -H "Content-Type: application/json" ^
  -d "{\"remark\":\"过期\"}"
# 拿可撤销 ID
curl -b cookies.txt http://localhost:3000/api/samples/$SCRAP_ID/reversable-actions
# 撤销报废
curl -b cookies.txt -X POST http://localhost:3000/api/samples/$SCRAP_ID/reverse/$TIMELINE_ID_SCRAP ^
  -H "Content-Type: application/json" ^
  -d "{\"reason\":\"还能用\"}"
```

### 5. 历史查询

```bash
# 5.1 按条码查（含完整时间线 + 差异记录）
curl -b cookies.txt "http://localhost:3000/api/history/search?barcode=验收-S3"

# 5.2 按批次查（返回该批次所有样本）
curl -b cookies.txt "http://localhost:3000/api/history/search?batch_no=BATCH-验收"

# 5.3 按盘点单号查（注意参数名是 inventory_order_id，传 order_no 也支持）
curl -b cookies.txt "http://localhost:3000/api/history/search?inventory_order_id=$INV_ID"
```

---

## 非法场景拦截验证

| 场景 | 操作步骤 | 预期结果 |
|------|----------|----------|
| **未入库直接出库** | 新增样本后立刻调用出库 | `样本未入库或已出库，无法执行出库操作` |
| **库位已满转入** | 某库位容量=1，先入库1个，再转第二个 | `目标库位已满（容量X），无法转入` |
| **重复条码** | 新增相同条码样本或导入重复 | `条码已存在`，导入时该条计入失败数 |
| **报废后继续操作** | 先报废，再调用入库/转移/出库 | `样本已报废，无法操作` |
| **温区不匹配入库** | 样本要求温区=冷冻，入库选冷藏库位 | `温区不匹配：样本应放冷冻，当前库位属冷藏` |
| **库管员处理差异** | warehouse 登录调 resolve 接口 | `{ success: false, forbidden: true }` |

---

## 预置初始数据

系统首次启动时自动创建以下数据（可在配置页修改/删除）：

**温区**:
- 冷藏(2-8℃)、冷冻(-20℃)、深冻(-80℃)、常温(15-25℃)

**库位**:
- R-A1 / R-A2（冷藏区，容量20）
- F-B1 / F-B2（冷冻区，容量15）
- D-C1（深冻区，容量10）
- N-D1（常温区，容量30）
