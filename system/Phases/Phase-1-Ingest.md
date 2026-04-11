# Phase 1: 攝取 (Ingest)

將外部資料導入系統的第一階段。

## 資料來源

### 網頁文章
- **Obsidian Web Clipper**：瀏覽器擴充功能，將網頁轉換為乾淨的 `.md` 文件
- 圖片自動下載至本地

### 學術論文與代碼庫
- arXiv 論文
- GitHub 存放庫
- 數據集

### 其他文件
- PDF、Markdown、TXT 等格式

## 工作流程

```
來源 --> raw/ --> LLM 處理 --> staging/ --> 編譯進維基
```

## 操作步驟

1. **收集來源**
   - 使用瀏覽器擴充功能剪藏網頁文章
   - 下載論文 PDF 至 `raw/`
   - Clone GitHub 存放庫或擷取 README

2. **放置文件**
   - 將所有原始文件放入 `raw/` 目錄
   - 圖片自動下載至 `Attachment/`

3. **初步整理**
   - 建立 `0.Pending/` 追蹤待處理文件
   - 可手動移動至 `staging/` 開始處理

## 注意事項

- raw/ 是系統的緩衝區，所有文件先到此
- 不要直接修改 raw/ 中的文件
- LLM 編譯器會從 staging/ 讀取並處理
