# 冷链样本入库出库追踪系统

基于 Node.js + Express + SQLite 的轻量级冷链样本全生命周期追踪管理系统。

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

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
npm start
```

启动后访问: **http://localhost:3000**

## 目录结构

```
├── server.js          # 后端服务 + API 路由 + 业务校验
├── db.js              # SQLite 数据库初始化与连接
├── package.json       # 项目配置
├── data/              # SQLite 数据库文件目录（自动创建）
│   └── tracker.db     # 持久化数据文件（重启不丢失）
└── public/
    └── index.html     # 前端单页管理界面
```

## 页面验证步骤

### 1. 台账概览页（首页）
- 打开页面自动显示 7 项统计数据（总数/在库/待入库/已出库/已报废/温控异常/温区不匹配）
- 「风险样本预警」表格显示有问题的样本（温区不匹配或有温控异常记录）
- 「库位容量监控」表格显示各库位已用/容量比例，已满/即将满有标识

### 2. 样本管理页
- **新增样本**: 点击「➕ 新增样本」，填写条码 TEST001、批次 BATCH001、选择要求温区「冷藏(2-8℃)」，提交
- **条码查询**: 点击「🔍 条码查询」输入 TEST001，直达详情页
- **搜索过滤**: 顶部搜索框支持条码/批次/名称模糊搜索，下拉框按状态筛选
- **批量导入**: 点击「📥 批量导入」，在文本框粘贴以下内容后导入：
  ```
  条码,批次号,名称,要求温区
  TEST002,BATCH001,血清样本,冷藏(2-8℃)
  TEST003,BATCH001,组织样本,冷冻(-20℃)
  TEST004,BATCH002,试剂,常温(15-25℃)
  ```
- **批量导出**: 点击「📤 导出CSV」下载当前所有样本

### 3. 样本详情页（主流程验证）
点击任一样本「详情」进入详情页：
- **位置突出显示**: 当前位置用黄色高亮卡片显示，位于详情顶部
- **追踪时间线**: 下方时间线按时间顺序展示所有动作，不同操作不同颜色节点

执行完整主流程：
1. **登记**: 新增样本后状态为「待入库」，时间线显示「登记」记录
2. **入库**: 点击「入库」按钮，选择库位 R-A1（冷藏区），提交。状态变为「在库」，时间线增加入库节点
3. **转移**: 点击「转移」按钮，选择库位 R-A2，提交。时间线显示 R-A1 → R-A2
4. **温控异常**: 点击「温控异常」，填 15℃ 和说明，时间线增加黄色异常节点
5. **出库**: 点击「出库」，填写备注后提交。状态变为「已出库」，时间线完成闭环

### 4. 库位配置页
- **温区管理**: 新增/编辑/删除温区，设置温度范围
- **库位管理**: 新增/编辑/删除库位，指定所属温区与容量
- 修改后的数据会持久化到 SQLite，重启服务后仍然存在

### 5. 非法场景验证

| 场景 | 操作步骤 | 预期结果 |
|------|----------|----------|
| **未入库直接出库** | 新增一个样本（状态为待入库），对其调用出库 | 提示"样本未入库或已出库，无法执行出库操作" |
| **转入已满库位** | 先将某库位容量改为 1，入库 1 个样本，再尝试将第二个样本转入该库位 | 提示"目标库位已满（容量X），无法转入" |
| **重复条码导入** | 新增条码 TEST001，再用批量导入或新增录入相同条码 | 提示"条码已存在，不能重复登记"，导入时该条被跳过并计入失败数 |
| **报废后继续移动** | 对样本执行报废（填写原因），再尝试入库/转移/出库 | 所有操作均提示"样本已报废，无法操作" |
| **温区不匹配** | 新增样本指定要求温区「冷冻(-20℃)」，入库时选择冷藏区库位 R-A1 | 提示"温区不匹配：样本应放指定温区，当前库位属于冷藏(2-8℃)"，操作被拦截 |

### 6. 持久化与重启验证
1. 登记若干样本并完成一些操作（入库、转移等）
2. 记录条码号（例如 TEST001）
3. 关闭服务（Ctrl+C）再重启 `npm start`
4. 点击「🔍 条码查询」输入 TEST001
5. 验证：样本状态、当前位置、追踪时间线完整保留，与重启前完全一致

---

## API 接口列表

所有接口统一返回格式：`{ success: boolean, data?: any, error?: string }`

### 温区管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/zones` | 获取所有温区 |
| POST | `/api/zones` | 新增温区 `{ name, min_temp, max_temp, description }` |
| PUT | `/api/zones/:id` | 编辑温区 |
| DELETE | `/api/zones/:id` | 删除温区（有库位时禁止） |

### 库位管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/locations` | 获取所有库位（含占用数） |
| POST | `/api/locations` | 新增库位 `{ code, name, zone_id, capacity, description }` |
| PUT | `/api/locations/:id` | 编辑库位 |
| DELETE | `/api/locations/:id` | 删除库位（有样本在库时禁止） |

### 样本管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/samples` | 样本列表，支持 `?keyword=&status=` 查询 |
| GET | `/api/samples/:id` | 样本详情 + 追踪时间线 |
| GET | `/api/samples/barcode/:barcode` | 按条码查询样本 + 时间线 |
| POST | `/api/samples` | 登记样本 `{ barcode, batch_no, name, required_zone_id, operator }` |
| POST | `/api/samples/:id/inbound` | 入库 `{ location_id, remark, operator }` |
| POST | `/api/samples/:id/transfer` | 转移 `{ to_location_id, remark, operator }` |
| POST | `/api/samples/:id/outbound` | 出库 `{ remark, operator }` |
| POST | `/api/samples/:id/scrap` | 报废 `{ remark, operator }` |
| POST | `/api/samples/:id/temp-exception` | 温控异常 `{ temperature, remark, operator }` |

### 批量导入导出

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/samples/export/csv` | 导出全部样本为 CSV 文件 |
| POST | `/api/samples/import/csv` | 批量导入 `{ rows: [{barcode,batch_no,name,required_zone}], operator }` |

### 台账统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/dashboard/stats` | 获取统计数据、风险样本、满库位列表 |

### API 快速验证（curl 示例）

```bash
# 1. 登记样本
curl -X POST http://localhost:3000/api/samples ^
  -H "Content-Type: application/json" ^
  -d "{\"barcode\":\"API001\",\"batch_no\":\"BATCH-API\",\"name\":\"测试样本\",\"operator\":\"tester\"}"

# 2. 入库（假设 location_id=1，即 R-A1）
curl -X POST http://localhost:3000/api/samples/1/inbound ^
  -H "Content-Type: application/json" ^
  -d "{\"location_id\":1,\"operator\":\"tester\"}"

# 3. 转移到 location_id=2（R-A2）
curl -X POST http://localhost:3000/api/samples/1/transfer ^
  -H "Content-Type: application/json" ^
  -d "{\"to_location_id\":2,\"operator\":\"tester\"}"

# 4. 出库
curl -X POST http://localhost:3000/api/samples/1/outbound ^
  -H "Content-Type: application/json" ^
  -d "{\"operator\":\"tester\",\"remark\":\"实验使用完毕\"}"

# 5. 按条码查询追踪历史
curl http://localhost:3000/api/samples/barcode/API001

# 6. 非法场景：未入库样本尝试出库（假设样本 2 是待入库状态）
curl -X POST http://localhost:3000/api/samples/2/outbound ^
  -H "Content-Type: application/json" ^
  -d "{}"
```

## 预置初始数据

系统首次启动时自动创建以下数据（可在配置页修改/删除）：

**温区**:
- 冷藏(2-8℃)、冷冻(-20℃)、深冻(-80℃)、常温(15-25℃)

**库位**:
- R-A1 / R-A2（冷藏区，容量20）
- F-B1 / F-B2（冷冻区，容量15）
- D-C1（深冻区，容量10）
- N-D1（常温区，容量30）
