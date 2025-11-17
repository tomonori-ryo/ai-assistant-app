import { NextRequest, NextResponse } from 'next/server';
import { updateUserSettingsServer } from '../../../../lib/firestoreAdmin';
import { getAuthenticatedUid } from '../../../../lib/authServer';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-2.0-flash';

export async function POST(req: NextRequest) {
  try {
    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured');
    }

    const body = await req.json();
    const message = body.message || body.user_input;
    const context = body.context;
    const timetableClasses = body.timetable_classes || [];
    const userTimings = body.timings || []; // ユーザーが設定した時限の時刻
    
    if (!message) {
      return NextResponse.json(
        { error: 'Message or user_input is required' },
        { status: 400 }
      );
    }
    
    console.log('[School Learn API] Received message:', message.substring(0, 200));
    console.log('[School Learn API] Timetable classes:', timetableClasses.length);
    console.log('[School Learn API] User timings:', userTimings.length);

    // 学習中のプロファイル（セッション管理）
    const learningProfile = context?.learningProfile || {
      name: '',
      schedule: [],
      timings: [],
      rules: {},
      vacations: [],
      color: '#93c5fd'
    };

    const conversationHistory = context?.conversationHistory || [];

    const systemPrompt = `あなたは学生の「**時間割・授業スケジュール**」を学習するAIアシスタントです。
ユーザーとの対話を通じて、以下の情報を収集し、JSON形式で学校プロファイルを作成してください。

【収集する情報】
1. **学校名**: 大学名、学部名など
2. **時間割**: 曜日、時限、科目名、教室（オプション）
3. **授業時間**: 各時限の開始・終了時刻（例：1限 9:20-10:50）
4. **ルール**: 
   - 祝日は休講か？
   - その他の休講ルール
5. **長期休暇**: 夏休み、冬休み、春休みの期間

【重要：OCR読み取り時の注意】
- OCRで読み取った時間割には、**文字化けや誤認識が含まれる可能性があります**
- 例：「才ソ5」→「システム」、「廿一八一」→「ソフトウェア」など
- 読み取れなかった科目名や不明瞭な部分は、**具体的にどの曜日・時限の科目か**を明記して質問してください
- 例：「月曜1限の科目名が読み取れませんでした。正式な科目名を教えてください。」

【OCRテキストの構造理解（超重要！）】
OCRテキストは、時間割表を左から右、上から下の順にスキャンした結果です。

**典型的な構造:**
  時限 / 月 / 火 / 水 / 木 / 金 / 9:20 / [月1限科目] / [火1限科目] / [水1限科目] / [木1限科目] / [金1限科目] / 1 / 10:10 / [月1限先生] / [火1限先生] / ... / 10:20 / [月2限科目] / [火2限科目] / ... / 2 / ...

**解析の鉄則:**
1. 時限番号（1,2,3,4,5）を見つける
2. 時限番号の**直前**に並んでいる複数の科目を、左から順に「月、火、水、木、金」に割り当てる
3. 例: "AI概論 制作演習 デザイン" の後に "1" → 月1限=AI概論、火1限=制作演習、水1限=デザイン
4. 同じ科目が複数回出現する場合、それぞれ異なる曜日または時限の授業
5. 曜日の順序は必ず「月→火→水→木→金」
6. 先生名も同様のパターンで、科目の直後に出現する

**注意:**
- 空欄（授業がない）の場合、その曜日は飛ばされる
- 水曜、木曜、金曜のデータが後ろの方に出現することがある
- 全ての曜日のデータを見逃さないよう、OCRテキスト全体を慎重に解析してください

**実例による解析手順:**
もしOCRテキストが「... 9:20 AI概論 制作演習 1 10:10 浦出先生 大村先生 10:20 AI概論 制作演習 2 ...」の場合:
- "1"の直前: "AI概論 制作演習" → 月1限=AI概論（浦出先生）、火1限=制作演習（大村先生）
- "2"の直前: "AI概論 制作演習" → 月2限=AI概論（浦出先生）、火2限=制作演習（大村先生）

もしOCRテキストに「... 13:10 企画I Web開発 制作演習 4 14:00 岡田(直)先生 志摩先生 大村先生 ...」がある場合:
- "4"の直前: "企画I Web開発 制作演習" → 月4限=企画I（岡田(直)先生）、火4限=Web開発（志摩先生）、水4限=制作演習（大村先生）

もしOCRテキストの後半に「... 木 デザイン 金 AIリテラシー ...」がある場合:
- これらは後ろの方で出現した木曜・金曜のデータです
- **「曜日名」の直後に出現する科目は、その曜日の授業です**
- 例：「木 デザイン」→ 木曜日にデザインの授業がある
- 例：「金 AIリテラシー」→ 金曜日にAIリテラシーの授業がある
- これらの授業の時限番号は、前後の文脈や時刻情報から推測してください
- 同じ科目が複数時限続く場合もあります

**重要：水曜日・木曜日・金曜日のデータを見逃さないでください**
- OCRテキストの最初の方（時限番号1,2,3...の直前）に出現しない曜日のデータは、OCRテキストの後半に別の形式で出現します
- 「曜日名 + 科目名」のパターンを探してください
- 例：OCRテキストに「水 制作演習」があれば、水曜日に制作演習の授業があります
- 例：OCRテキストに「木 デザイン」があれば、木曜日にデザインの授業があります
- 例：OCRテキストに「金 AIリテラシー」があれば、金曜日にAIリテラシーの授業があります

**実際の解析例（ユーザーの正しい時間割）:**

正解：
- 月曜: AI概論(1-3限) + 企画I(4-5限)
- 火曜: 制作演習(1-2限) + 企画I(3限) + Web開発(4限) + データリテラシー(5限)
- 水曜: 制作演習(1限) + データリテラシー(2-3限) + **Web開発(4-5限)**
- 木曜: デザイン(1-3限) + **制作演習(4-5限)**
- 金曜: AIリテラシー(1限) + ロボット開発(2-5限)

**OCRテキストの解析方法:**
1. 時限番号「1」の直前に「AI概論 制作演習」→ 月1限=AI概論、火1限=制作演習
2. 時限番号「4」の直前に「企画I Web開発 制作演習」があれば：
   - 月4限=企画I
   - 火4限=Web開発
   - **水4限=制作演習** ← ここで水曜の4限が決まる
3. 「木 デザイン」→ 木曜日にデザインがある（1-3限）
4. 「金 AIリテラシー」→ 金曜日にAIリテラシーがある（1限）

**重要：4-5限の割り当て**
- 水曜4-5限は、時限番号の直前に出現した科目（Web開発）です
- 木曜4-5限は、時限番号の直前には出現せず、別の場所に記載されています（制作演習）
- 同じ科目が複数の曜日に出現する場合、出現位置とパターンから慎重に判断してください

**必ず全ての曜日（月、火、水、木、金）について授業を抽出してください。**

【現在の学習状況】
${JSON.stringify(learningProfile, null, 2)}

【会話履歴】
${conversationHistory.map((m: any) => `${m.role}: ${m.content}`).join('\n')}

【ユーザーの最新メッセージ】
${message}

${timetableClasses.length > 0 ? `
【AI解析済みの時間割データ】
以下は、OCR画像から自動解析された時間割データです。この情報を優先的に使用してください：
${JSON.stringify(timetableClasses, null, 2)}
` : ''}

【回答フォーマット】
以下のJSON形式で回答してください：
{
  "is_complete": true/false,
  "reply": "ユーザーへの応答メッセージ",
  "updated_profile": {
    "name": "学校名",
    "schedule": [
      {"day": "MONDAY", "period": 1, "subject": "英語", "location": "A101"},
      ...
    ],
    "timings": [
      {"period": 1, "start": "09:00", "end": "10:30"},
      ...
    ],
    "rules": {
      "national_holidays_jp": "OFF",
      "custom_rules": "その他のルール"
    },
    "vacations": [
      {"name": "夏休み", "start": "08-01", "end": "09-20"}
    ],
    "color": "#93c5fd"
  },
  "next_question": "次に聞くべき質問（is_completeがfalseの場合）"
}

【重要な指示】
- 【AI解析済みの時間割データ】がある場合は、それを優先的に使って schedule と timings を自動構築してください
  - day_of_week（月、火、水...）→ 英語大文字（MONDAY, TUESDAY...）に変換
  - period → そのまま使用
  - subject → そのまま使用（OCR誤認識の可能性があるが、後でユーザーが修正可能）
  - start_time, end_time → そのまま使用
  - location → teacher がある場合は使用
- timings は、AI解析データから時限ごとにユニークな開始・終了時刻を抽出してください
  例: [{"period": 1, "start": "09:20", "end": "10:10"}, {"period": 2, "start": "10:20", "end": "11:10"}]
- **schedule と timings の構築（重要）:**
  - OCRテキストから読み取った時間割は、**必ず schedule に追加してください**
  - 時刻情報がある場合は、timings も構築してください
  - 時刻情報がない場合でも、schedule だけは構築してください（ユーザーが後で時刻を設定します）

- **is_complete の判断基準（全て必須）:**
  1. 学校名が設定されている
  2. 時間割データ（schedule）が存在する ← **OCRから読み取った場合は必ず追加**
  3. **各時限の開始・終了時刻（timings）が設定されている** ← 必須！
  4. 祝日ルールが設定されている
- **schedule は常に構築し、timings が不足している場合のみ is_complete: false にしてください**
- **特に timings が空の場合、必ず is_complete: false にしてください**（timings がないとカレンダー登録ができません）
- 曜日は英語大文字（MONDAY, TUESDAY...）で統一
- 時刻はHH:mm形式（24時間制）
- 長期休暇の日付はMM-DD形式
- ユーザーフレンドリーな会話を心がける`;

    const payload = {
      contents: [
        {
          parts: [{ text: systemPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2000,
      },
    };

    const response = await fetch(
      `${API_BASE}/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[School Learn API] Gemini error:', errorText);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    console.log('[School Learn API] AI response:', text);
    
    // JSONを抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse AI response');
    }
    
    const result = JSON.parse(jsonMatch[0]);
    
    // ユーザーが設定した時限の時刻を優先的に使用
    if (userTimings.length > 0 && result.updated_profile) {
      result.updated_profile.timings = userTimings;
      console.log('[School Learn API] Applied user-defined timings:', userTimings.length);
    }

    // 学習が完了した場合、Firestoreに保存
    if (result.is_complete && result.updated_profile) {
      try {
        const uid = await getAuthenticatedUid(req);
        if (!uid) {
          console.warn('[School Learn API] No UID found, skipping save');
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        console.log('[School Learn API] Saving school profile to Firestore...');
        
        await updateUserSettingsServer(uid, {
          school_profile: result.updated_profile
        });
        
        console.log('[School Learn API] School profile saved successfully');
      } catch (saveError) {
        console.error('[School Learn API] Failed to save to Firestore:', saveError);
        // エラーでも学習結果は返す（ユーザーに再試行の機会を与える）
      }
    }

    return NextResponse.json({
      success: true,
      is_complete: result.is_complete || false,
      reply: result.reply || '',
      updated_profile: result.updated_profile || learningProfile,
      next_question: result.next_question || null
    });
  } catch (error: any) {
    console.error('[School Learn API] Error:', error);
    return NextResponse.json(
      { 
        success: false,
        error: error?.message || 'Failed to learn school profile',
        reply: 'AI処理中にエラーが発生しました。もう一度お試しください。'
      },
      { status: 500 }
    );
  }
}

