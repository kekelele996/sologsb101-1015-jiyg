# 古树名木复壮养护档案（sologsb101-1015）

面向园林部门的古树名木保护岗：为一树一档建立检查、复壮、加固与长势复评的完整记录，
按保护科周期标准自动提示加固件超期，并按季度容量生成待检排期；长势为衰弱 / 濒危时强制填写后续措施。

两侧职责严格分开：

* **巡检班**：记录「树体检查」，上门发现倾斜超限 / 空洞高风险只记入检查记录、**不改变加固件周期**；
  加固件检查结果按季度整批上报，被退回后整批重报。
* **保护科**：管「加固件台账、按保护级别的周期标准、每季度检查容量、批次对账结论与长势复评结论」。

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
        ├── types/              # tree/survey/measure/support/review + cycle/inspection/setting
        ├── stores/             # treeStore measureStore reviewStore supportStore
        ├── components/common/  # VigorTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useTreeHistory.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（含加固件检查批次对账页）
        ├── router/index.ts     # 路由表 + ROUTES 常量
        └── utils/              # dimension db export seed id quarter scheduling inspection
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/trees` | `pages/TreeList.vue` | 古树一树一档：新建/编辑/级联删除、按保护级别与树种筛选、回显检查次数与最新长势等级 |
| `/trees/:id/surveys` | `pages/TreeSurvey.vue` | 树体与立地检查（巡检班）：录树高/胸径/冠幅/倾斜/空洞并对比上次、年化生长量、古树历史时间线 |
| `/measures` | `pages/MeasureBoard.vue` | 复壮措施台账：按类型与实施状态筛选、行内草稿、批量改状态，完成即回写最近复壮日期 |
| `/supports` | `pages/SupportBoard.vue` | 加固件台账（保护科）：按保护级别维护周期标准与每季度容量，按容量生成季度排期，到期件排队等下一批 |
| `/inspections` | `pages/InspectionBoard.vue` | 加固件检查批次（巡检上报 / 保护科对账）：整批校验、一条不过整批退回、回齐后对账重算排期 |
| `/reviews` | `pages/ReviewView.vue` | 长势复评与结构版本（保护科）：衰弱/濒危强制填写后续措施、历史时间线、JSON 导入导出 |

`/` 重定向到 `/trees`，未匹配路径统一回落到 `/trees`。
**层级路由支持直接深链**：把 `http://localhost:22815/trees/tree-guozijian-0007/surveys` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「古树档案不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbheritagetree`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`。
  * `version(1)` 建立全部表；`version(2)` 补齐索引并回填历史字段；
  * `version(3)` 落地巡检 / 保护科职责拆分，执行 `.upgrade()` 迁移：
    * 新增 `cycleStandards`（按保护级别的周期标准）、`inspectionBatches`（检查批次）、`settings`（每季度容量，单行）三张表；
    * `supports` 增加 `scheduledQuarter` 排期索引，并补齐 `scheduledQuarter` / `reconciledAt` 字段；
    * **已有数据缺周期档位的，升级时按现有档案的保护级别回填**：一级 6 个月、二级 12 个月、三级 24 个月（仅对缺失 / 非正数周期回填，保留合法历史值）；
    * 缺省每季度检查容量 3 件，并防御性补齐历史 `lastMeasureDate` / `followUp`。
  * 打开数据库与导入旧档后都会跑 `ensureBaseline()`，保证周期标准三档与容量设置始终存在。
* **表结构**：

  | 表 | 主键 | 主要索引 | 归属 |
  | --- | --- | --- | --- |
  | `trees` | id | code, species, protectLevel, ageYears, createdAt, updatedAt, owner | 保护科（级别以现档为准） |
  | `surveys` | id | treeId, [treeId+date], date, siteNote | 巡检班（树体检查记录） |
  | `measures` | id | treeId, type, state, date, operator | 复壮措施台账 |
  | `supports` | id | treeId, type, installDate, lastCheckDate, scheduledQuarter | 保护科（加固件台账 + 排期） |
  | `reviews` | id | treeId, date, vigor, trend | 保护科（长势复评结论） |
  | `cycleStandards` | id（一级/二级/三级） | — | 保护科（周期标准） |
  | `inspectionBatches` | id | quarter, state | 巡检上报 → 保护科对账 |
  | `settings` | id（固定 `app`） | — | 保护科（每季度容量） |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `trees` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **古树 → 树体检查 / 复壮措施 / 加固件 / 周期标准 / 检查批次 / 长势复评**：
  * 3 株古树（京-01-0007 国槐 一级 / 京-02-0113 银杏 一级 / 京-05-0246 侧柏 二级）；
  * 9 条树体检查、8 条复壮措施、5 件加固件（周期按保护级别定档，含超期与已排入本季样本）、
    3 档周期标准（6 / 12 / 24 个月）、每季度容量 2 件；
  * 3 个检查批次分别覆盖「待对账（含巡检旧级别与现档不一致提示）/ 已退回整批重报 / 已对账重算」三种状态；
  * 7 条长势复评（含衰弱 / 濒危样本且均已填写后续措施）。
  * 固定 id 如 `tree-guozijian-0007`、`tree-xiangshan-0113`、`tree-ritan-0246` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的古树 id」这一界面偏好，不存业务数据。
* 删除古树会**级联清理**其下的树体检查、复壮措施、加固件、复评记录，并从检查批次中剔除对应条目（同一 Dexie 事务内完成）。

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

* **职责分开**：巡检班只写树体检查记录与加固件检查批次；保护科管加固件台账、周期标准、每季度容量、对账与长势复评结论。
* **倾斜安全阈值**：< 5° 正常；5°–10° 需关注；> 10° 超限（`src/utils/dimension.ts`）。
* **空洞风险**：1–2 处需关注，≥ 3 处判定为高风险，建议立即安排树洞修补与防腐处理。
* **生长量年化**：由最近两次检查的差值按实际天数折算为「每年」增量，间隔不足 30 天时退回直接差值。
* **加固件周期由保护科按保护级别定档**（`src/utils/scheduling.ts` + `cycleStandards` 表）：
  巡检班上门才发现倾斜超限或空洞高风险，只记入树体检查，**不改变加固件周期**；现场无最近检查记录时按安装日期起算。
* **保护级别以现档为准**：保护科改过级别后，周期与对账一律取古树当前档案；巡检批次里带回的旧级别仅留痕、不采信（只给提示，不作为退回理由）。
* **整批退回、台账不动**：交回的检查批次逐条校验（台账缺失 / 类型不符 / 未来日期 / 日期倒填 / 缺现场说明 / 同件重复等），
  **有一条不对就整批退回重报**，退回期间保护科台账不做任何改动；巡检班更正后整批重新上报。
* **回齐对账、覆盖件重算**：整批通过后才对账，覆盖到的加固件按「保护科周期 + 本批最新检查日期」重算下次到期，
  **原排期作废**（清空 `scheduledQuarter`）并重新进待检清单。
* **季度容量与排队**：每季度检查容量有限，到期（含超期）件按到期日先后入排，当季排满后其余的**排队等下一批**；
  未到期件不占名额；已查完（对账通过）的件不再改期。
* **历史数据升级回填**：已有数据缺周期档位的，v3 升级时按现有档案保护级别回填周期与三档标准（`version(3).upgrade()`）。
* **加固件超期高亮**：按「保护科有效周期」计算，超期件列表高亮并在顶部汇总。
* **复评强制校验**：长势为「衰弱」或「濒危」时，后续措施为必填项，未填写无法保存。
* **措施回写**：复壮措施状态改为「已完成」时，若实施日期晚于古树现有最近复壮日期，则自动回写该日期。
