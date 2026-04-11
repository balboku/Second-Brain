---
title: LLM 知識庫系統
description: 基於 Karpathy 架構的個人知識庫系統
type: reference
---

# LLM 知識庫系統

一個由 LLM 作為編譯器的結構化維基系統，無需向量資料庫或嵌入技術。

## 系統架構

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Phase 1   │ --> │   Phase 2   │ --> │   Phase 3   │ --> │   Phase 4   │
│   Ingest    │     │  Compile    │     │ Query&Enhance│     │   Lint      │
│   攝取       │     │   編譯       │     │   查詢增強   │     │   檢查      │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │                   │
       ▼                   ▼                   ▼                   ▼
    raw/              wiki/              Obsidian IDE         一致性掃描
  原始文件             結構化維基           Q&A 查詢              連接建議
```

## 目錄結構

```
├── raw/                    # 原始文件存放（攝取階段）
├── staging/                # 暫存處理中文件
├── system/                 # 流程規範、核心說明、操作文件
│   ├── Phases/             # Phase 1-4 操作指南
│   ├── lint/               # 系統檢查清單與維護規範
│   ├── index/              # 操作索引與待處理清單
│   └── queue/              # 批次查詢佇列
├── wiki/                   # 最終知識產出
│   ├── 概念/               # 概念文章（~100篇）
│   ├── articles/           # 原始文章整理結果
│   ├── 全域索引.md         # 知識庫入口索引
│   ├── queries/            # Q&A 最終輸出
│   ├── slides/             # Marp 簡報
│   ├── charts/             # 圖表
│   └── lint/               # 檢查報告
└── Attachment/             # 附件
```

## 四個階段

| 階段 | 功能 | 關鍵產出 |
|------|------|----------|
| Phase 1 | 攝取 | raw/ 中的原始文件 |
| Phase 2 | 編譯 | 結構化維基、概念文章 |
| Phase 3 | 查詢 | 問答結果、可視化 |
| Phase 4 | 檢查 | 一致性報告、連接建議 |

## 開始使用

1. 將文件放入 `raw/` 目錄
2. 參閱各 Phase 的操作指南
3. 使用 Obsidian 開啟此資料夾作為 vault
4. 將 `system/` 視為流程與規範區，將 `wiki/` 視為最終結果區

詳見各 Phase 文件：
- [Phase 1: 攝取](./Phases/Phase-1-Ingest.md)
- [Phase 2: 編譯](./Phases/Phase-2-Compile.md)
- [Phase 3: 查詢增強](./Phases/Phase-3-Query-Enhance.md)
- [Phase 4: 檢查維護](./Phases/Phase-4-Lint.md)
