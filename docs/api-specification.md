# API仕様書 - AIパーソナル秘書システム

**バージョン:** 1.0  
**作成日:** 2025年10月29日  
**ベースURL:** `https://api.ai-personal-assistant.com/v1`

---

## 1. 認証

### 1.1. OAuth 2.0認証

```http
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**レスポンス:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "def502003ad..."
}
```

---

## 2. チャット・入力API

### 2.1. 自然言語入力処理

```http
POST /chat/input
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "message": "明日19時からAさんと飲み会",
  "context": "schedule_input"
}
```

**レスポンス:**
```json
{
  "status": "success",
  "parsed_event": {
    "title": "Aさんと飲み会",
    "start_time": "2025-10-30T19:00:00Z",
    "duration": 120,
    "category": "余暇",
    "confidence": 0.95
  },
  "clarification_needed": false,
  "ai_response": "明日19時からAさんとの飲み会を登録しました。場所も教えていただけますか？"
}
```

### 2.2. 画像入力（OCR）処理

```http
POST /chat/image-input
Authorization: Bearer {access_token}
Content-Type: multipart/form-data

{
  "image": [ファイル],
  "type": "schedule_table"
}
```

**レスポンス:**
```json
{
  "status": "success",
  "extracted_events": [
    {
      "title": "バイト",
      "start_time": "2025-10-24T09:00:00Z",
      "end_time": "2025-10-24T17:00:00Z",
      "category": "仕事・勉強"
    }
  ],
  "ocr_confidence": 0.98,
  "confirmation_required": true
}
```

---

## 3. スケジュール・タスク管理API

### 3.1. タスク作成

```http
POST /tasks
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "title": "企画書作成",
  "description": "新プロジェクトの企画書を作成する",
  "due_date": "2025-11-15T23:59:59Z",
  "priority": "high",
  "category": "仕事・勉強"
}
```

### 3.2. スケジュール取得

```http
GET /schedule?start_date=2025-10-29&end_date=2025-11-05
Authorization: Bearer {access_token}
```

**レスポンス:**
```json
{
  "events": [
    {
      "id": "evt_123",
      "title": "歯医者",
      "start_time": "2025-10-25T15:00:00Z",
      "end_time": "2025-10-25T16:00:00Z",
      "category": "生活・雑務",
      "priority_score": 8
    }
  ],
  "tasks": [
    {
      "id": "task_456",
      "title": "企画書作成",
      "due_date": "2025-11-15T23:59:59Z",
      "priority_score": 9,
      "subtasks": [
        {"title": "市場調査", "completed": false},
        {"title": "競合分析", "completed": true}
      ]
    }
  ]
}
```

---

## 4. AI提案API

### 4.1. 隙間時間の提案

```http
GET /ai/suggestions/free-time
Authorization: Bearer {access_token}
```

**レスポンス:**
```json
{
  "suggestions": [
    {
      "time_slot": {
        "start": "2025-10-29T14:00:00Z",
        "end": "2025-10-29T16:00:00Z"
      },
      "recommended_task": {
        "id": "task_456",
        "title": "企画書作成",
        "reason": "締切が近く、2時間で市場調査部分を完了できます"
      },
      "confidence": 0.87
    }
  ]
}
```

### 4.2. 動的リスケジュール

```http
POST /ai/reschedule
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "completed_task_id": "task_123",
  "actual_duration": 30,
  "scheduled_duration": 60
}
```

**レスポンス:**
```json
{
  "status": "success",
  "freed_time": 30,
  "new_suggestions": [
    {
      "task_id": "task_789",
      "title": "メール返信",
      "recommended_start": "2025-10-29T15:30:00Z"
    }
  ],
  "updated_schedule": [...]
}
```

---

## 5. 通知API

### 5.1. プッシュ通知設定

```http
PUT /notifications/settings
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "focus_mode_enabled": true,
  "work_hours": {
    "start": "09:00",
    "end": "18:00"
  },
  "notification_types": {
    "task_reminders": true,
    "free_time_suggestions": true,
    "schedule_conflicts": true
  }
}
```

---

## 6. 振り返りAPI

### 6.1. 日次振り返りデータ

```http
GET /insights/daily?date=2025-10-29
Authorization: Bearer {access_token}
```

**レスポンス:**
```json
{
  "date": "2025-10-29",
  "completed_tasks": 5,
  "total_tasks": 7,
  "productivity_score": 0.85,
  "focus_time": 240,
  "categories": {
    "仕事・勉強": {"completed": 3, "total": 4},
    "生活・雑務": {"completed": 2, "total": 2},
    "余暇": {"completed": 0, "total": 1}
  },
  "ai_feedback": "今日は仕事タスクの完了率が高く、素晴らしい一日でした！明日は余暇の時間も確保してリフレッシュしましょう。"
}
```

---

## 7. エラーレスポンス

### 7.1. 標準エラー形式

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "入力された日時が無効です",
    "details": "未来の日付を指定してください",
    "timestamp": "2025-10-29T12:00:00Z"
  }
}
```

### 7.2. エラーコード一覧

| コード | 説明 | HTTPステータス |
|--------|------|----------------|
| `UNAUTHORIZED` | 認証が必要です | 401 |
| `FORBIDDEN` | アクセス権限がありません | 403 |
| `NOT_FOUND` | リソースが見つかりません | 404 |
| `INVALID_INPUT` | 入力データが無効です | 400 |
| `RATE_LIMIT_EXCEEDED` | レート制限に達しました | 429 |
| `INTERNAL_ERROR` | 内部サーバーエラー | 500 |

---

## 8. レート制限

| エンドポイント | 制限 |
|----------------|------|
| `/chat/*` | 100リクエスト/分 |
| `/tasks/*` | 200リクエスト/分 |
| `/ai/*` | 50リクエスト/分 |
| その他 | 500リクエスト/分 |

---

**文書更新日:** 2025年10月29日
