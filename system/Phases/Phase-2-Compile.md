# Phase 2: 編譯 (Compile)

LLM 作為編譯器，將原始文件轉換為標準化的結構化維基，並同時維護詞彙一致性。

## 核心功能

### 概念提煉
- 將來源文件重構為具備 YAML Metadata 的概念筆記。
- 自動提取關鍵字與標籤。
- 建立雙向連結與相關概念引用。

### 詞彙字典自動擴充 (Glossary Expansion)
- **術語鎖定**：系統會自動讀取 `system/glossary.json` 並注入 AI 提示中。
- **標準化標籤**：要求 AI 在生成 `#標籤` 時，若術語包含空格，必須轉換為連字號 `-`（例如：`Breast Surgery` -> `#Breast-Surgery`）。
- **自動建議同義詞**：AI 發現新的同義詞時會主動回傳建議。
- **字典合併**：外掛會自動將建議詞彙寫入 `system/glossary.json`，並在下次掃描時自動生效。

### 索引與摘要
- 自動維護 `wiki/articles/` 摘要文章。
- 作為全域索引的資料來源。

## 工作流程

```
raw/ --> LLM 編譯器 --> 結構化維基 (wiki/)
           ↑
    讀取 glossary.json
           ↓
    建議新對應關係 --> 更新 glossary.json
```

## 操作步驟

1. **準備來源**
   - 將文字或 PDF 放入 `raw/` 或 `staging/`。

2. **執行編譯**
   - 執行 `Run Phase 2 compile` 或 `Run full pipeline`。
   - 系統會自動執行字典注入與自動建議解析。

3. **檢查字典**
   - 可隨時開啟 `system/glossary.json` 查看 AI 自動整理的詞彙映射。

## 產出目錄

| 目錄 | 內容 |
|------|------|
| `wiki/概念/` | 主題概念筆記 |
| `wiki/articles/` | 來源文章的結構化摘要 |
| `wiki/全域索引.md` | 全域入口點 |

---
> [!NOTE]
> Phase 2 已支援增量編譯，內容未變更的檔案將自動跳過，節省 API 消耗。
