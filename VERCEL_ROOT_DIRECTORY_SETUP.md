# Vercelルートディレクトリ設定ガイド

## 問題
Vercelが`package.json`を見つけられず、ビルドが失敗する場合、ルートディレクトリが正しく設定されていない可能性があります。

## 解決方法

### 方法1: Vercelダッシュボードで設定（推奨）

1. **AIMOアプリ（web/）**:
   - https://vercel.com/tomos-projects-375194bf/web/settings にアクセス
   - 「General」タブを開く
   - 「Build & Development Settings」セクションを探す
   - 「Root Directory」に `web` を入力
   - 「Save」をクリック

2. **管理サイト（admin/）**:
   - https://vercel.com/tomos-projects-375194bf/admin/settings にアクセス
   - 「General」タブを開く
   - 「Build & Development Settings」セクションを探す
   - 「Root Directory」に `admin` を入力
   - 「Save」をクリック

### 方法2: プロジェクトを再作成

「Root Directory」が見つからない場合は、プロジェクトを再作成してください：

1. **既存プロジェクトを削除**:
   - Vercelダッシュボードでプロジェクトを開く
   - 「Settings」→「General」→「Delete Project」をクリック

2. **プロジェクトを再作成**:
   - 「Add New...」→「Project」をクリック
   - GitHubリポジトリを選択
   - 「Configure Project」画面で：
     - **Framework Preset**: Next.js
     - **Root Directory**: `web` または `admin` を選択
     - 「Deploy」をクリック

### 方法3: vercel.jsonでビルドコマンドをカスタマイズ

`vercel.json`でビルドコマンドをカスタマイズすることもできますが、これは推奨されません：

```json
{
  "buildCommand": "cd web && npm install && npm run build",
  "outputDirectory": "web/.next"
}
```

ただし、この方法は複雑になるため、**方法1または方法2を推奨**します。

## 確認方法

設定後、以下のコマンドで確認できます：

```bash
cd /Users/tomonoriryo/Desktop/assistant/web
vercel inspect --token Te9y58LcTUvIOaskmv9Vi8YZ
```

## トラブルシューティング

- **「Root Directory」が見つからない**: プロジェクトを再作成する（方法2）
- **ビルドが失敗する**: ルートディレクトリが正しく設定されているか確認
- **環境変数が読み込まれない**: 環境変数が正しく設定されているか確認

