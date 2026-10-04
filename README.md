# 古树名木复壮养护档案（sologsb101-1015）

面向园林部门的古树名木保护岗：为一树一档建立检查、复壮、加固与长势复评的完整记录，
按检查周期自动提示加固件超期，长势为衰弱 / 濒危时强制填写后续措施。

两侧职责分开：**巡检班**只记录树体检查（编组批次交回、被整批退回后重报）；**保护科**管
加固件台账、按保护级别制定检查周期标准与每季度检查容量、负责批次核对 / 整批退回 / 对账并出具长势复评结论。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22815**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbheritagetree` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 | `<script setup>` 组合式 API |
| 语言 | TypeScript 5 | `strict` 模式，`vue-tsc --noEmit` 零错误 |
| UI 组件库 | Element Plus 2 | 表格、表单、弹窗、日期选择、时间线、消息提示 |
| 图标 | @element-plus/icons-vue | 入口统一全局注册 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22815） |
| 路由 | Vue Router 4 | `createWebHistory` + 路由懒加载 |
| 状态管理 | Pinia 2 | setup store，跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbheritagetree`，含 v1 → v2 → v3 升级迁移 |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1015/
├── README.md
├── docker-compose.yml          # name: gbheritagetree，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：Pinia + Router + Element Plus + 初始化数据库
        ├── App.vue             # 外壳：顶部导航 + 当前古树上下文 + 页脚
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # tree.ts survey.ts measure.ts support.ts review.ts cycle.ts batch.ts plan.ts
        ├── stores/             # treeStore.ts measureStore.ts reviewStore.ts batchStore.ts cycleStore.ts roleStore.ts
        ├── components/common/  # VigorTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useTreeHistory.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（含检查批次 BatchBoard）
        ├── router/index.ts     # 路由表 + ROUTES 常量
        └── utils/              # dimension.ts cycle.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/trees` | `pages/TreeList.vue` | 古树一树一档：新建/编辑/级联删除、按保护级别与树种筛选、回显检查次数与最新长势等级（保护科可编辑，巡检班只读） |
| `/trees/:id/surveys` | `pages/TreeSurvey.vue` | 巡检班树体与立地检查：录树高/胸径/冠幅/倾斜/空洞并对比上次、年化生长量、古树历史时间线；交回 / 对账批次内记录锁定 |
| `/batches` | `pages/BatchBoard.vue` | 树体检查批次：巡检班编组 / 交齐交回 / 退回重报；保护科核对、整批退回、对账后重排待检清单 |
| `/measures` | `pages/MeasureBoard.vue` | 复壮措施台账：按类型与实施状态筛选、行内草稿、批量改状态，完成即回写最近复壮日期 |
| `/supports` | `pages/SupportBoard.vue` | 保护科加固件台账：按现档级别套周期标准、季度容量待检清单（排不完顺延）、周期标准与容量维护 |
| `/reviews` | `pages/ReviewView.vue` | 保护科长势复评与结构版本：衰弱/濒危强制填写后续措施、历史时间线、JSON 导入导出 |

`/` 重定向到 `/trees`，未匹配路径统一回落到 `/trees`。
**层级路由支持直接深链**：把 `http://localhost:22815/trees/tree-guozijian-0007/surveys` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「古树档案不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbheritagetree`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引与回写字段，
  `version(3)` 实现两侧职责分开：
  * `surveys` 增加 `[treeId+date]` 复合索引、`measures` 增加 `operator` 索引、`supports` 增加 `lastCheckDate` 索引；
  * v2：回填 `revision` / `createdAt` / `updatedAt`，补齐 `trees.lastMeasureDate`、`reviews.followUp`、
    `supports.lastCheckDate` 与 `checkCycleMon` 缺省值；
  * v3 新表：`cycleStandards`（保护级别 → 检查周期月数）、`appSettings`（每季度检查容量等键值设置）、
    `surveyBatches`（检查批次：草稿 / 已交回 / 已退回 / 已对账）、
    `supportCheckPlans`（待检 / 已查 / 已作废计划，按季度排队）；
  * v3 字段：`surveys` 增加 `batchId` 与 `protectLevelSnapshot`；
    `supports` 删除逐件手填的 `checkCycleMon`，改为 `cycleLevel` 周期档位（**存量缺档位的，升级时按古树现有档案
    保护级别回填**，生效周期始终按现档级别查周期标准）；
  * v3 升级时写入默认周期标准（一级 6 个月 / 二级 12 个月 / 三级 24 个月）、默认每季度容量 2 件，
    并为全部加固件生成初始待检计划（按到期日与季度容量装箱，排不完的顺延到之后季度）。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `trees` | id | code, species, protectLevel, ageYears, createdAt, updatedAt, owner |
  | `surveys` | id | treeId, [treeId+date], date, siteNote, batchId |
  | `measures` | id | treeId, type, state, date, operator |
  | `supports` | id | treeId, type, installDate, lastCheckDate |
  | `reviews` | id | treeId, date, vigor, trend |
  | `cycleStandards` | id（保护级别） | — |
  | `appSettings` | id（键） | — |
  | `surveyBatches` | id | status, visitDate |
  | `supportCheckPlans` | id | supportId, treeId, quarter, status |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `trees` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **古树 → 树体检查 / 复壮措施 / 加固件 / 长势复评** 三层互相引用：
  * 3 株古树（京-01-0007 国槐 一级 / 京-02-0113 银杏 一级 / 京-05-0246 侧柏 二级）；
  * 9 条树体检查（每株 3 次，树高胸径随日期递增）、8 条复壮措施（覆盖计划 / 实施中 / 已完成）、
    5 件加固件（其中 **京-01-0007 支撑杆** 与 **京-05-0246 避雷** 故意超周期未检查，用于验证高亮与排队）、
    7 条长势复评（含衰弱 / 濒危样本且均已填写后续措施）；
  * 周期标准 3 条、季度容量设置 1 条；
  * 检查批次 4 个，覆盖 **已对账 / 已交回（巡检带回旧级别「三级」，现档已由保护科调整为「二级」）/
    已退回（含退回原因）/ 草稿** 四种状态；
  * 待检计划按容量装箱（2026Q4 两件超期件，其余顺延 2027Q1 / Q2），并保留 1 条「已查」冻结历史。
  * 固定 id 如 `tree-guozijian-0007`、`tree-xiangshan-0113`、`tree-ritan-0246` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的古树 id」与「当前操作角色（巡检班 / 保护科）」界面偏好，不存业务数据。
* 删除古树会**级联清理**其下的树体检查、复壮措施、加固件与复评记录（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22815
```

其他命令：

```bash
npm run build        # vue-tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **两侧职责分开**：巡检班只登记树体检查记录并编组批次；保护科管古树档案与保护级别、加固件台账、
  检查周期标准、季度容量、待检清单与长势复评结论。顶栏可切换「巡检班 / 保护科」角色，切换后越权按钮自动隐藏。
* **倾斜安全阈值**：< 5° 正常；5°–10° 需关注；> 10° 超限（`src/utils/dimension.ts`）。
* **空洞风险**：1–2 处需关注，≥ 3 处判定为高风险，建议立即安排树洞修补与防腐处理。
* **巡检发现不改加固排期**：巡检班上门才发现的倾斜超限 / 空洞高风险只写入树体检查记录，
  加固件检查周期照旧排；周期只由保护科修改标准或在批次对账时按现档级别重算。
* **加固件周期标准**：周期不由加固件逐件填写，而由所属古树**现档保护级别**查 `cycleStandards` 得到
  （默认 一级 6 个月 / 二级 12 个月 / 三级 24 个月）。古树保护级别被保护科调整后，台账以「待重算」标记，
  下批次对账按现档刷新；标准或容量修改后待检队列立即重排。
* **检查批次整批退回**：巡检班批次交齐（交回条数 = 计划株数）才能交回，交回后明细锁定；
  保护科核对发现**任意一条不对即整批退回**，退回时加固件台账 / 周期 / 待检清单一律不动，
  仅批次置为已退回并解锁明细，巡检班修正后重新交回。
* **对账重算**：批次核对无误后对账。保护级别一律以古树**现档**为准，巡检带回的旧级别仅对照展示、不参与计算；
  覆盖到的加固件以「批次内该树最新检查日期」回写最近检查日期并刷新周期档位，**原待检计划作废**，
  随后全部待检计划按周期标准 + 季度容量重新装箱排队，批次置为已对账、明细继续锁定。
* **季度容量排队**：每季度可检查的加固件数量由保护科在 `appSettings` 设置（默认 2 件），
  待检计划按到期日先后装箱，**排不完的顺延到之后季度**；从未检查 / 已超期的件从当前季度开始排队。
* **查完的不再改**：在待检清单「登记已查」后，该计划冻结为已查历史（不参与任何后续重排 / 对账），
  加固件最近检查日期推进到检查日，并按新周期生成下一条待检计划重新排队。
* **生长量年化**：由最近两次检查的差值按实际天数折算为「每年」增量，间隔不足 30 天时退回直接差值。
* **加固件超期**：`最近检查日期 + 生效周期（月）` 早于今天即为超期，列表自动高亮并在顶部汇总提醒。
* **复评强制校验**：长势为「衰弱」或「濒危」时，后续措施为必填项，未填写无法保存。
* **措施回写**：复壮措施状态改为「已完成」时，若实施日期晚于古树现有最近复壮日期，则自动回写该日期。
* **存量数据升级**：v2 → v3 升级时为缺周期档位的加固件按现有档案保护级别回填，自动补齐周期标准、
  容量与初始待检队列；导入旧版 JSON 存档时同样归一化并重排。
