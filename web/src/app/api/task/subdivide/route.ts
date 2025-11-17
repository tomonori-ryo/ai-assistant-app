import { NextRequest, NextResponse } from 'next/server';
import { getUserLearningProfileServer } from '@/lib/firestoreAdmin';
import type { UserLearningProfile } from '@/lib/firestore';
import { fetchBigData, getBigDataSuggestion, MIN_EXECUTIONS_FOR_PERSONAL_DATA } from '@/lib/bigdata';
import { getAuth } from 'firebase-admin/auth';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Gemini APIで細分化（Step 3: 最終手段）
async function subdivideWithGemini(
  title: string,
  description?: string,
  dueDate?: string,
  messages: Array<any> = []
): Promise<{ subtasks: Array<{ title: string; dueDate?: string }>; reason: string }> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  // 今日の日付を取得
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD形式

  const dueDateInfo = dueDate ? `\n期限: ${new Date(dueDate).toLocaleDateString('ja-JP')} (${dueDate})` : '';

  // 会話履歴がある場合は、それを考慮したプロンプトを生成
  let prompt = '';
  
  if (messages.length > 0) {
    // 対話モード：ユーザーの補足を反映
    prompt = `あなたはタスク細分化の専門AIです。ユーザーの補足・調整指示に基づいて、サブタスクの提案を改善してください。

# 現在の日付
**今日は ${todayStr} です。**

# 元のタスク
タスク: ${title}${description ? `\n詳細: ${description}` : ''}${dueDateInfo}

# これまでの会話
${messages.map((m: any) => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n')}

# 指示
上記の会話を踏まえて、ユーザーの要望に応じたサブタスクを提案してください。
各サブタスクには、適切な期限も設定してください。

以下のJSON形式で回答してください：
{
  "subtasks": [
    {
      "title": "サブタスク1",
      "dueDate": "YYYY-MM-DD"
    },
    {
      "title": "サブタスク2",
      "dueDate": "YYYY-MM-DD"
    }
  ],
  "reason": "調整内容の説明"
}

重要：
- 期限は必ず「YYYY-MM-DD」形式で設定してください
- 期限は必ず今日（${todayStr}）以降の日付にしてください
- 親タスクの期限${dueDate ? `（${dueDate}）` : ''}がある場合は、それより前に設定してください
- サブタスクは実行順序を考慮して、早く着手すべきものほど早い期限を設定してください`;
  } else {
    // 初回モード：通常の細分化
    prompt = `以下のタスクを、実行可能な3〜5個のサブタスクに細分化してください。

# 現在の日付
**今日は ${todayStr} です。**

# タスク情報
タスク: ${title}${description ? `\n詳細: ${description}` : ''}${dueDateInfo}

以下のJSON形式で回答してください：
{
  "subtasks": [
    {
      "title": "サブタスク1",
      "dueDate": "YYYY-MM-DD"
    },
    {
      "title": "サブタスク2",
      "dueDate": "YYYY-MM-DD"
    }
  ],
  "reason": "この細分化にした理由の簡潔な説明"
}

サブタスクの作成基準：
- 具体的で実行可能なアクションに分解
- 各サブタスクは30分〜2時間で完了できる粒度
- 論理的な順序で並べる（先に着手すべきものから順に）
- チェックリストとして使いやすい表現にする
- 3〜5個程度が最適（多すぎず少なすぎず）

期限設定のルール：
- 期限は必ず「YYYY-MM-DD」形式で設定してください
- 期限は必ず今日（${todayStr}）以降の日付にしてください
- 親タスクの期限${dueDate ? `（${dueDate}）` : ''}がある場合は、それより前に設定してください
- サブタスクは実行順序を考慮して、早く着手すべきものほど早い期限を設定してください
- 例えば親タスクの期限が10日後なら、サブタスクを3日後、5日後、8日後のように段階的に設定してください

例：
タスク「企画書を作成する」（期限: 2025-11-20）
→ サブタスク: 
[
  {"title": "調査・リサーチを行う", "dueDate": "2025-11-12"},
  {"title": "構成を考える", "dueDate": "2025-11-14"},
  {"title": "ドラフトを書く", "dueDate": "2025-11-17"},
  {"title": "図表を作成する", "dueDate": "2025-11-18"},
  {"title": "最終チェックと修正", "dueDate": "2025-11-19"}
]`;
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 800,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  // JSONを抽出
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse AI response');
  }
  
  const result = JSON.parse(jsonMatch[0]);
  
  return {
    subtasks: result.subtasks || [],
    reason: result.reason || ''
  };
}

export async function POST(req: NextRequest) {
  try {
    const { title, description, dueDate, messages = [], force_gemini = false, goal_id, user_id } = await req.json();
    
    if (!title) {
      return NextResponse.json(
        { error: 'Task title is required' },
        { status: 400 }
      );
    }
    
    // === 3段階AI頭脳選択アルゴリズム ===
    
    // 対話モードまたは強制Geminiの場合は、Step 1-2をスキップ
    if (messages.length > 0 || force_gemini) {
      console.log('[Subdivide] 🔄 対話モード/再提案: Geminiを使用');
      const geminiResult = await subdivideWithGemini(title, description, dueDate, messages);
      
      return NextResponse.json({
        success: true,
        subtasks: geminiResult.subtasks || [],
        reason: geminiResult.reason || '',
        source: 'gemini',
        cost_incurred: true,
        message: '🤖 Gemini AIが高品質な提案を生成しました'
      });
    }
    
    // === Step 1: 個人のオリジナルデータ ===
    console.log('[Subdivide] Step 1: 個人データをチェック');
    
    // user_idがない場合はStep 1-2をスキップ
    let profile: UserLearningProfile | null = null;
    if (user_id) {
      try {
        profile = await getUserLearningProfileServer(user_id);
      } catch (err) {
        console.warn('[Subdivide] プロファイル取得失敗、Step 3へ:', err);
      }
    }
    
    if (goal_id && profile?.category_stats[goal_id]) {
      const stats = profile.category_stats[goal_id];
      
      // 10回以上実行し、かつ細分化パターンがある場合
      if (stats.execution_count >= MIN_EXECUTIONS_FOR_PERSONAL_DATA && 
          stats.subdivision_patterns && 
          stats.subdivision_patterns.length > 0) {
        
        const topPattern = stats.subdivision_patterns[0];  // 最頻出パターン
        
        console.log('[Subdivide] ✓ Step 1成功: 個人の細分化パターンを使用', {
          goal_id,
          pattern: topPattern.pattern,
          used_count: topPattern.used_count
        });
        
        // 期限を自動設定（親タスクの期限から逆算）
        const subtasksWithDates = topPattern.pattern.map((title, index) => {
          let calculatedDate = null;
          if (dueDate) {
            const parentDue = new Date(dueDate);
            const today = new Date();
            const totalDays = Math.ceil((parentDue.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            const interval = Math.max(1, Math.floor(totalDays / topPattern.pattern.length));
            const subtaskDate = new Date(today.getTime() + (interval * (index + 1) * 24 * 60 * 60 * 1000));
            calculatedDate = subtaskDate.toISOString().split('T')[0];
          }
          
          return { title, dueDate: calculatedDate };
        });
        
        return NextResponse.json({
          success: true,
          subtasks: subtasksWithDates,
          reason: `あなたの過去の実績から提案（${topPattern.used_count}回使用）`,
          source: 'personal',
          cost_incurred: false,
          show_retry_button: true,
          message: `👤 あなたの過去${stats.execution_count}回の実績と頻出パターンから提案`
        });
      }
    }
    
    // === Step 2: AIMOビッグデータ ===
    console.log('[Subdivide] Step 2: ビッグデータをチェック');
    
    const bigData = await fetchBigData();
    const bigDataEntry = bigData.find(entry => 
      title.includes(entry.category) || entry.category.includes(title.split(' ')[0])
    );
    
    if (bigDataEntry && bigDataEntry.confidence_score >= 0.7) {
      console.log('[Subdivide] ✓ Step 2成功: ビッグデータを使用', {
        category: bigDataEntry.category,
        confidence: bigDataEntry.confidence_score
      });
      
      // 最頻出パターンを使用
      const topPattern = bigDataEntry.common_subdivisions?.[0];
      
      if (topPattern && topPattern.pattern.length > 0) {
        // 期限を自動設定
        const subtasksWithDates = topPattern.pattern.map((title, index) => {
          let calculatedDate = null;
          if (dueDate) {
            const parentDue = new Date(dueDate);
            const today = new Date();
            const totalDays = Math.ceil((parentDue.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            const interval = Math.max(1, Math.floor(totalDays / topPattern.pattern.length));
            const subtaskDate = new Date(today.getTime() + (interval * (index + 1) * 24 * 60 * 60 * 1000));
            calculatedDate = subtaskDate.toISOString().split('T')[0];
          }
          
          return { title, dueDate: calculatedDate };
        });
        
        return NextResponse.json({
          success: true,
          subtasks: subtasksWithDates,
          reason: `AIMOユーザー${bigDataEntry.total_executions}人の実績から提案`,
          source: 'bigdata',
          cost_incurred: false,
          show_retry_button: true,
          message: `📊 他のAIMOユーザーの実績データから提案（信頼度: ${(bigDataEntry.confidence_score * 100).toFixed(0)}%）`
        });
      }
    }
    
    // === Step 3: Gemini API（最終手段） ===
    console.log('[Subdivide] ⚠️ Step 3: Gemini APIを使用（コールドスタート）');
    
    const geminiResult = await subdivideWithGemini(title, description, dueDate, messages);

    return NextResponse.json({
      success: true,
      subtasks: geminiResult.subtasks || [],
      reason: geminiResult.reason || '',
      source: 'gemini',
      cost_incurred: true,
      show_retry_button: false,  // すでにGemini使用済み
      message: '🤖 Gemini AIが高品質な提案を生成しました（新規カテゴリ）'
    });
  } catch (error: any) {
    console.error('[Task Subdivide API] Error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to subdivide task' },
      { status: 500 }
    );
  }
}

