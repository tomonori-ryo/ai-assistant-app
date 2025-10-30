# 技術アーキテクチャ - AIパーソナル秘書システム

**バージョン:** 1.0  
**作成日:** 2025年10月29日

---

## 1. システム全体アーキテクチャ

### 1.1. アーキテクチャ概要図

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Layer                               │
├─────────────────────┬─────────────────────┬─────────────────┤
│   Mobile App        │    Web App          │   API Clients   │
│   (React Native)    │    (React)          │   (3rd Party)   │
└─────────────────────┴─────────────────────┴─────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                 API Gateway Layer                            │
├─────────────────────────────────────────────────────────────┤
│  Rate Limiting │ Authentication │ Load Balancing │ Logging  │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                 Microservices Layer                          │
├───────────────┬────────────────┬────────────────┬───────────┤
│   Chat API    │  Schedule API  │   AI Engine    │ OCR API   │
│   Service     │   Service      │   Service      │ Service   │
└───────────────┴────────────────┴────────────────┴───────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                   Data Layer                                 │
├─────────────────┬─────────────────┬─────────────────────────┤
│   PostgreSQL    │     Redis       │    File Storage         │
│   (Main DB)     │   (Cache)       │    (AWS S3)             │
└─────────────────┴─────────────────┴─────────────────────────┘
```

### 1.2. テクノロジースタック

#### フロントエンド
- **モバイル:** React Native 0.72+
- **Web:** React 18+ + TypeScript
- **状態管理:** Redux Toolkit + RTK Query
- **UI:** React Native Elements / Material-UI

#### バックエンド
- **API:** FastAPI (Python 3.11+)
- **認証:** JWT + OAuth 2.0
- **タスクキュー:** Celery + Redis
- **API Gateway:** Kong / AWS API Gateway

#### データベース
- **メインDB:** PostgreSQL 15+
- **キャッシュ:** Redis 7+
- **ファイルストレージ:** AWS S3 / MinIO
- **検索:** Elasticsearch (ログ・分析用)

#### AI・機械学習
- **LLM:** OpenAI GPT-4 / Anthropic Claude
- **OCR:** Google Cloud Vision API
- **自然言語処理:** spaCy + 独自モデル

#### インフラ
- **コンテナ:** Docker + Docker Compose
- **オーケストレーション:** Kubernetes
- **CI/CD:** GitHub Actions
- **監視:** Prometheus + Grafana

---

## 2. マイクロサービス設計

### 2.1. サービス一覧

#### Chat API Service
- **責務:** 自然言語入力の処理、チャットボット機能
- **技術:** FastAPI + OpenAI API
- **データ:** チャット履歴、ユーザーコンテキスト

#### Schedule API Service  
- **責務:** カレンダー・タスク管理、CRUD操作
- **技術:** FastAPI + SQLAlchemy
- **データ:** イベント、タスク、スケジュール

#### AI Engine Service
- **責務:** 優先順位算出、提案ロジック、動的リスケジュール
- **技術:** Python + scikit-learn + 独自アルゴリズム
- **データ:** ユーザー行動データ、学習モデル

#### OCR API Service
- **責務:** 画像からのテキスト抽出、スケジュール解析
- **技術:** Python + Google Vision API
- **データ:** 画像ファイル、抽出結果

#### Notification Service
- **責務:** プッシュ通知、集中モード制御
- **技術:** Node.js + Firebase FCM
- **データ:** 通知履歴、設定

### 2.2. サービス間通信

```python
# API Gateway → Chat Service (HTTP REST)
POST /api/v1/chat/input
{
    "user_id": "user_123",
    "message": "明日19時から会議",
    "context": "schedule"
}

# Chat Service → AI Engine (gRPC)
rpc ProcessNaturalLanguage(NLPRequest) returns (NLPResponse);

# AI Engine → Schedule Service (HTTP)
POST /internal/schedule/create
{
    "user_id": "user_123",
    "event": {...}
}
```

---

## 3. データベース設計

### 3.1. PostgreSQL スキーマ

#### Users テーブル
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    timezone VARCHAR(50) DEFAULT 'UTC',
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

#### Events テーブル
```sql
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    category event_category DEFAULT 'other',
    priority_score INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TYPE event_category AS ENUM (
    'work_study', 'life_chores', 'leisure', 'other'
);
```

#### Tasks テーブル
```sql
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    due_date TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    priority_score INTEGER DEFAULT 0,
    category event_category DEFAULT 'other',
    parent_task_id UUID REFERENCES tasks(id),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### 3.2. Redis キャッシュ設計

```python
# ユーザーセッション
"session:user_123" → {
    "access_token": "jwt_token",
    "refresh_token": "refresh_token", 
    "expires_at": "2025-10-29T18:00:00Z"
}

# 今日のタスクキャッシュ
"daily_tasks:user_123:2025-10-29" → [
    {"id": "task_1", "priority": 9, "title": "企画書作成"},
    {"id": "task_2", "priority": 7, "title": "会議準備"}
]

# AI提案キャッシュ
"ai_suggestions:user_123" → {
    "free_time_slots": [...],
    "generated_at": "2025-10-29T12:00:00Z",
    "expires_in": 1800
}
```

---

## 4. AI・機械学習アーキテクチャ

### 4.1. 自然言語処理パイプライン

```python
class NLPPipeline:
    def __init__(self):
        self.tokenizer = spacy.load("ja_core_news_sm")
        self.llm_client = OpenAIClient()
        self.date_parser = DateParser()
    
    def process(self, text: str, user_context: dict) -> ParsedEvent:
        # 1. 前処理・トークン化
        tokens = self.tokenizer(text)
        
        # 2. エンティティ抽出
        entities = self.extract_entities(tokens)
        
        # 3. LLMによる意図解析
        intent = self.llm_client.analyze_intent(
            text, user_context, entities
        )
        
        # 4. 構造化データ生成
        return self.generate_structured_event(intent, entities)
```

### 4.2. 優先度算出アルゴリズム

```python
class PriorityScoring:
    def calculate_score(self, task: Task, user: User) -> float:
        # 基本スコア計算
        deadline_score = self._calc_deadline_score(task.due_date)
        importance_score = self._calc_importance_score(task.category)
        effort_score = self._calc_effort_score(task.estimated_duration)
        
        # ユーザー履歴による重み付け
        personal_weight = self._calc_personal_weight(task, user)
        
        # 最終スコア
        return (
            deadline_score * 0.4 +
            importance_score * 0.3 +
            effort_score * 0.2 +
            personal_weight * 0.1
        )
```

---

## 5. セキュリティアーキテクチャ

### 5.1. 認証・認可フロー

```
1. ユーザーログイン
   ├── メール・パスワード検証
   ├── JWTアクセストークン発行 (1時間)
   └── リフレッシュトークン発行 (30日)

2. API リクエスト
   ├── JWTトークン検証
   ├── ユーザー権限確認  
   └── レート制限チェック

3. トークンリフレッシュ
   ├── リフレッシュトークン検証
   └── 新しいアクセストークン発行
```

### 5.2. データ暗号化

- **転送時暗号化:** TLS 1.3
- **保存時暗号化:** AES-256-GCM
- **データベース:** PostgreSQL の透過的データ暗号化
- **ファイル:** S3 Server-Side Encryption

### 5.3. プライバシー保護

```python
# 個人情報の匿名化
class DataAnonymizer:
    def anonymize_user_data(self, data: dict) -> dict:
        return {
            "user_id": self.hash_user_id(data["user_id"]),
            "events": self.anonymize_events(data["events"]),
            "created_at": data["created_at"]  # タイムスタンプは保持
        }
```

---

## 6. 監視・ログ設計

### 6.1. 監視メトリクス

#### アプリケーションメトリクス
- API レスポンス時間（95パーセンタイル < 2秒）
- エラーレート（< 1%）
- AI処理精度（> 95%）
- ユーザーアクティブ数

#### インフラメトリクス  
- CPU使用率（< 80%）
- メモリ使用率（< 85%）
- ディスクI/O
- ネットワーク帯域

### 6.2. 構造化ログ

```json
{
  "timestamp": "2025-10-29T12:00:00Z",
  "level": "INFO",
  "service": "chat-api",
  "user_id": "user_123",
  "request_id": "req_456",
  "event": "nlp_processing",
  "duration_ms": 150,
  "ai_confidence": 0.95,
  "metadata": {
    "input_type": "text",
    "output_events": 1
  }
}
```

---

## 7. デプロイメント・インフラ

### 7.1. Kubernetes デプロイ

```yaml
# chat-api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chat-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: chat-api
  template:
    spec:
      containers:
      - name: chat-api
        image: ai-assistant/chat-api:v1.0.0
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: url
```

### 7.2. CI/CD パイプライン

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run tests
        run: pytest tests/
      
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Build Docker image
        run: docker build -t ai-assistant/chat-api:${{ github.sha }} .
      
      - name: Deploy to K8s
        run: kubectl apply -f k8s/
```

---

**文書更新日:** 2025年10月29日
