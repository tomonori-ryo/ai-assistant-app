# 🚀 Vercelでのデプロイ手順

## デプロイ方法

### 方法1: スクリプトを使用（推奨）

```bash
./deploy-vercel.sh
```

### 方法2: 手動でデプロイ

#### AIMOアプリ（web/）

```bash
cd /Users/tomonoriryo/Desktop/assistant/web
vercel --token Te9y58LcTUvIOaskmv9Vi8YZ --prod --yes
```

#### 管理サイト（admin/）

```bash
cd /Users/tomonoriryo/Desktop/assistant/admin
vercel --token Te9y58LcTUvIOaskmv9Vi8YZ --prod --yes
```

---

## プロジェクト設定

### ルートディレクトリの設定（Vercel CLIを使用）

Vercelダッシュボードで「Root Directory」が見つからない場合は、Vercel CLIを使用して設定してください：

#### AIMOアプリ（web/）

```bash
cd /Users/tomonoriryo/Desktop/assistant/web
vercel link --token Te9y58LcTUvIOaskmv9Vi8YZ
# プロンプトが表示されたら：
# - Set up and deploy? → Y
# - Which scope? → tomos-projects-375194bf
# - Link to existing project? → Y
# - What's the name of your existing project? → web
# - In which directory is your code located? → ./
```

#### 管理サイト（admin/）

```bash
cd /Users/tomonoriryo/Desktop/assistant/admin
vercel link --token Te9y58LcTUvIOaskmv9Vi8YZ
# プロンプトが表示されたら：
# - Set up and deploy? → Y
# - Which scope? → tomos-projects-375194bf
# - Link to existing project? → Y
# - What's the name of your existing project? → admin
# - In which directory is your code located? → ./
```

**または、プロジェクトを再作成する方法：**

1. Vercelダッシュボードで既存のプロジェクトを削除
2. GitHubリポジトリを再度インポート
3. インポート時に「Root Directory」に `web` または `admin` を指定

**重要**: ルートディレクトリを設定しないと、Vercelが`package.json`を見つけられず、ビルドが失敗します。

## 環境変数の設定

デプロイ前に、Vercelダッシュボードで環境変数を設定してください：

### AIMOアプリ（web/）

1. https://vercel.com/tomos-projects-375194bf/web/settings/environment-variables にアクセス
2. 以下の環境変数を追加：
   - `NEXT_PUBLIC_FIREBASE_API_KEY`
   - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
   - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
   - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
   - `NEXT_PUBLIC_FIREBASE_APP_ID`
   - `FIREBASE_SERVICE_ACCOUNT_KEY`
   - `GEMINI_API_KEY`
   - `GOOGLE_MAPS_API_KEY`

### 管理サイト（admin/）

1. https://vercel.com/tomos-projects-375194bf/admin/settings/environment-variables にアクセス
2. 以下の環境変数を追加：
   - `NEXT_PUBLIC_FIREBASE_API_KEY`
   - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
   - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
   - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
   - `NEXT_PUBLIC_FIREBASE_APP_ID`
   - `FIREBASE_SERVICE_ACCOUNT_KEY`
   - `ALLOWED_ORIGIN`: `https://ai-assistant-app-docs.netlify.app`

---

## デプロイURL

デプロイ後、以下のURLでアクセスできます：

- **AIMOアプリ**: Vercelダッシュボードで確認
- **管理サイト**: Vercelダッシュボードで確認
- **紹介サイト**: https://ai-assistant-app-docs.netlify.app

---

## トラブルシューティング

### ビルドエラー

- Vercelダッシュボードでビルドログを確認
- 環境変数が正しく設定されているか確認
- Node.jsバージョンを確認（Vercelの設定で指定可能）

### 環境変数エラー

- すべての環境変数が正しく設定されているか確認
- 環境変数の値に余分なスペースや改行がないか確認

