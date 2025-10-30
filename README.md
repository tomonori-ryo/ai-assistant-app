# AIパーソナル秘書システム - ドキュメント集

<div align="center">

🤖 **生成AIサービス + MarkItDown によるシステムドキュメント** 📚

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python Version](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![Markdown](https://img.shields.io/badge/Markdown-000000?logo=markdown&logoColor=white)](https://www.markdownguide.org/)

</div>

---

## 📖 概要

このリポジトリは、**AIパーソナル秘書システム**の包括的なドキュメント集です。
Microsoft の **MarkItDown** ライブラリを活用して、様々な形式のドキュメントをMarkdown形式で管理・変換できる環境を提供します。

### 🎯 プロジェクトの特徴

- **🔄 自動変換:** PDF、Word、PowerPoint等を自動でMarkdownに変換
- **📝 統合ドキュメント:** システム仕様から技術詳細まで一元管理
- **🤖 AI活用:** 生成AIによる効率的なドキュメント作成・更新
- **🌍 日本語対応:** 日本語ドキュメントの完全サポート

---

## 📂 ドキュメント構成

```
📁 docs/
├── 📄 system-specification.md    # システム仕様書（メイン）
├── 🔧 api-specification.md      # REST API 仕様
├── 🏗️  technical-architecture.md # 技術アーキテクチャ
└── 📚 user-manual.md            # エンドユーザーマニュアル

📁 tools/
└── 🛠️  doc_converter.py          # MarkItDown 変換ツール

📄 requirements.txt              # Python依存関係
📄 README.md                    # このファイル
```

### 📋 各ドキュメントの内容

| ドキュメント | 内容 | 対象者 |
|-------------|------|--------|
| **システム仕様書** | 全体構成・機能要件・AIロジック | PO・開発者・ステークホルダー |
| **API仕様書** | RESTエンドポイント・認証・レスポンス形式 | フロントエンド・バックエンド開発者 |
| **技術アーキテクチャ** | インフラ・DB設計・セキュリティ | アーキテクト・DevOpsエンジニア |
| **ユーザーマニュアル** | アプリの使い方・設定・FAQ | エンドユーザー・サポート |

---

## 🚀 セットアップ

### 1. リポジトリクローン

```bash
git clone https://github.com/your-org/ai-personal-assistant-docs.git
cd ai-personal-assistant-docs
```

### 2. Python環境セットアップ

```bash
# Python 3.11+ が必要
python -m venv venv
source venv/bin/activate  # Linux/Mac
# または
venv\Scripts\activate     # Windows

# 依存関係インストール
pip install -r requirements.txt
```

### 3. 動作確認

```bash
# MarkItDownツールのテスト
python tools/doc_converter.py --list-formats

# サンプル変換（PDFファイルがある場合）
python tools/doc_converter.py sample.pdf
```

---

## 🛠️ MarkItDown 変換ツールの使い方

### 基本的な使用方法

#### 単一ファイル変換

```bash
# PDFをMarkdownに変換
python tools/doc_converter.py document.pdf

# 出力先を指定
python tools/doc_converter.py document.pdf --output custom_name.md

# WordファイルやPowerPointも対応
python tools/doc_converter.py presentation.pptx
python tools/doc_converter.py spreadsheet.xlsx
```

#### フォルダ一括変換

```bash
# フォルダ内のすべての対応ファイルを変換
python tools/doc_converter.py --batch input_folder/

# 出力先フォルダを指定
python tools/doc_converter.py --batch input_folder/ --output output_folder/
```

#### サポートされるファイル形式

- **📄 文書:** `.pdf`, `.docx`, `.doc`
- **📊 プレゼン:** `.pptx`, `.ppt`  
- **📈 表計算:** `.xlsx`, `.xls`
- **🌐 ウェブ:** `.html`, `.htm`
- **📝 テキスト:** `.txt`

### 実用的な活用例

#### 1. 既存ドキュメントのMarkdown化

```bash
# 既存のWord仕様書をMarkdownに変換
python tools/doc_converter.py legacy_spec.docx -o docs/converted-spec.md

# チーム全体の資料を一括変換
python tools/doc_converter.py --batch team_documents/ -o markdown_docs/
```

#### 2. プレゼン資料の文書化

```bash
# PowerPointのプレゼン資料を議事録として保存
python tools/doc_converter.py meeting_slides.pptx -o meeting_notes.md
```

#### 3. Excel設計書の変換

```bash  
# Excelのデータベース設計書をMarkdownに
python tools/doc_converter.py db_design.xlsx -o docs/database-schema.md
```

---

## 📚 ドキュメント管理のベストプラクティス

### 1. バージョン管理

```bash
# Gitでドキュメントをバージョン管理
git add docs/
git commit -m "📝 システム仕様書v1.1リリース - 新機能追加"
git tag v1.1.0
```

### 2. 自動変換ワークフロー

#### GitHub Actionsの例

```yaml
# .github/workflows/docs.yml
name: Auto Convert Documents
on:
  push:
    paths: ['input_docs/**']

jobs:
  convert:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Python
        uses: actions/setup-python@v3
        with:
          python-version: '3.11'
      
      - name: Install dependencies
        run: pip install -r requirements.txt
      
      - name: Convert documents
        run: |
          python tools/doc_converter.py --batch input_docs/ -o docs/
          
      - name: Commit changes
        run: |
          git config --local user.email "action@github.com"
          git config --local user.name "GitHub Action"
          git add docs/
          git commit -m "🤖 Auto-generated Markdown from source docs"
          git push
```

### 3. ドキュメント品質チェック

```bash
# Markdownのリント
markdownlint docs/*.md

# 内部リンクの検証
markdown-link-check docs/**/*.md

# 日本語の校正（textlint使用時）
textlint docs/*.md
```

---

## 🔧 開発・カスタマイズ

### MarkItDown変換ツールの拡張

#### カスタムコンバータの追加

```python
# tools/custom_converter.py
class CustomDocumentConverter(DocumentConverter):
    def __init__(self):
        super().__init__()
        # カスタム設定を追加
        self.custom_settings = {
            "preserve_tables": True,
            "extract_images": True
        }
    
    def post_process_markdown(self, content: str) -> str:
        """Markdown後処理をカスタマイズ"""
        # 日本語特有の調整
        content = self.fix_japanese_formatting(content)
        
        # 技術文書用の調整
        content = self.enhance_code_blocks(content)
        
        return content
```

#### AIとの連携強化

```python
# tools/ai_enhanced_converter.py
import openai

class AIEnhancedConverter(DocumentConverter):
    def enhance_with_ai(self, content: str) -> str:
        """AIを使ってMarkdownを改善"""
        prompt = f"""
        以下のMarkdown文書を改善してください：
        - 構造の最適化
        - 日本語の自然な表現
        - 技術文書としての読みやすさ
        
        {content}
        """
        
        response = openai.ChatCompletion.create(
            model="gpt-4",
            messages=[{"role": "user", "content": prompt}]
        )
        
        return response.choices[0].message.content
```

---

## 🤝 コントリビューション

### 文書の改善・追加

1. **Issue作成:** 改善点や新規ドキュメントの提案
2. **フォーク & ブランチ:** 作業用ブランチを作成
3. **編集 & テスト:** MarkItDownツールでの変換テスト
4. **プルリクエスト:** レビュー依頼

### ツールの改善

```bash
# 開発環境セットアップ
pip install -e .
pip install -r requirements-dev.txt

# テスト実行
pytest tests/
python -m pytest tests/test_converter.py -v

# コード品質チェック
flake8 tools/
black tools/
```

---

## 📊 メトリクス・分析

### 文書変換状況

```bash
# 変換成功率の確認
python tools/doc_converter.py --batch docs_input/ | grep "変換完了"

# パフォーマンス測定
time python tools/doc_converter.py large_document.pdf
```

### 文書品質分析

```python
# docs_analyzer.py
import matplotlib.pyplot as plt
from pathlib import Path

def analyze_docs():
    docs = Path('docs').glob('*.md')
    
    stats = {
        'total_files': len(list(docs)),
        'total_lines': sum(len(f.read_text().split('\n')) for f in docs),
        'avg_file_size': sum(f.stat().st_size for f in docs) / len(list(docs))
    }
    
    print(f"📊 ドキュメント統計: {stats}")
    return stats
```

---

## ⚙️ 設定・環境変数

### 環境変数の設定

```bash
# .env ファイル作成
echo "OPENAI_API_KEY=your_api_key_here" > .env
echo "GOOGLE_CLOUD_VISION_KEY=your_vision_key" >> .env
```

### 設定ファイル

```yaml
# config/converter_config.yaml
markitdown:
  output_format: "markdown"
  preserve_formatting: true
  extract_images: false
  
conversion:
  batch_size: 10
  timeout: 300
  retry_count: 3

ai_enhancement:
  enabled: true
  model: "gpt-4"
  temperature: 0.3
```

---

## 🚨 トラブルシューティング

### よくある問題

#### 1. MarkItDownのインストールエラー

```bash
# エラー: Microsoft Visual C++ 14.0 is required
# 解決方法:
pip install --upgrade setuptools wheel
pip install markitdown --no-cache-dir
```

#### 2. 日本語PDFの変換に失敗

```python
# 文字化け対策
import locale
locale.setlocale(locale.LC_ALL, 'ja_JP.UTF-8')

# フォント指定
converter.markitdown.config['pdf_font'] = 'NotoSansCJK'
```

#### 3. 大きなファイルの変換タイムアウト

```bash
# タイムアウト時間を延長
python tools/doc_converter.py large_file.pdf --timeout 600
```

---

## 📞 サポート・お問い合わせ

### 技術サポート

- **GitHub Issues:** バグ報告・機能要望
- **メール:** dev-support@ai-personal-assistant.com
- **Discord:** [開発者コミュニティ](https://discord.gg/ai-assistant-dev)

### ドキュメント関連

- **文書の誤り:** docs-feedback@ai-personal-assistant.com  
- **翻訳・ローカライゼーション:** i18n@ai-personal-assistant.com

---

## 📄 ライセンス

MIT License - 詳細は [LICENSE](LICENSE) ファイルを参照

---

## 🔗 関連リンク

- **MarkItDown 公式:** https://github.com/microsoft/markitdown
- **プロダクト公式サイト:** https://ai-personal-assistant.com
- **開発者ドキュメント:** https://docs.ai-personal-assistant.com  
- **API リファレンス:** https://api.ai-personal-assistant.com/docs

---

<div align="center">

**📝 最終更新:** 2025年10月29日  
**📋 ドキュメントバージョン:** 1.0.0

Made with ❤️ by AI Personal Assistant Team

</div>
