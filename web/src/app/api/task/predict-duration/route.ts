import { NextRequest, NextResponse } from 'next/server';
import { getUserLearningProfileServer } from '@/lib/firestoreAdmin';
import { predictWithModel, type RegressionModel } from '@/lib/regression';

// Gemini APIで予測（Phase 1: Initial フェーズ）
async function predictWithGemini(taskTitle: string, taskDescription?: string): Promise<number> {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('[Prediction] Gemini API key not found, using default');
      return 3600; // デフォルト: 1時間
    }
    
    const prompt = `
以下のタスクの所要時間を予測してください。
回答は「数値（分）」のみで答えてください。

タスク: ${taskTitle}
${taskDescription ? `説明: ${taskDescription}` : ''}

所要時間（分）:`;
    
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );
    
    if (!response.ok) {
      throw new Error('Gemini API failed');
    }
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // 数値を抽出
    const match = text.match(/(\d+)/);
    if (match) {
      const minutes = parseInt(match[1], 10);
      return minutes * 60; // 秒に変換
    }
    
    return 3600; // デフォルト
  } catch (error) {
    console.error('[Prediction] Gemini error:', error);
    return 3600; // エラー時はデフォルト
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { task_title, task_description, goal_id, user_id } = body;
    
    if (!task_title) {
      return NextResponse.json(
        { error: 'task_title is required' },
        { status: 400 }
      );
    }
    
    // user_idがない場合はGeminiにフォールバック
    if (!user_id) {
      console.log('[Prediction] user_id not provided, using Gemini');
      const geminiDuration = await predictWithGemini(task_title, task_description);
      
      return NextResponse.json({
        predicted_duration: geminiDuration,
        confidence: 'low',
        prediction_method: 'gemini',
        learning_phase: 'initial',
        message: 'Gemini APIで予測しました'
      });
    }
    
    // 学習プロファイルを取得
    const profile = await getUserLearningProfileServer(user_id);
    
    if (!profile) {
      console.log('[Prediction] Profile not found, using Gemini');
      const geminiDuration = await predictWithGemini(task_title, task_description);
      
      return NextResponse.json({
        predicted_duration: geminiDuration,
        confidence: 'low',
        prediction_method: 'gemini',
        learning_phase: 'initial',
        message: 'Gemini APIで予測しました'
      });
    }
    
    console.log('[Prediction] Request:', {
      task_title,
      goal_id,
      phase: profile.learning_phase,
      total_executions: profile.total_executions
    });
    
    // フェーズに応じて予測方法を切り替え
    switch (profile.learning_phase) {
      case 'initial':
        // Phase 1: Gemini APIで推測（高コスト）
        console.log('[Prediction] Using Gemini API (initial phase)');
        const geminiDuration = await predictWithGemini(task_title, task_description);
        
        return NextResponse.json({
          predicted_duration: geminiDuration,
          confidence: 'low',
          prediction_method: 'gemini',
          learning_phase: 'initial',
          message: 'Gemini APIで予測しました（高精度AI）'
        });
      
      case 'learning':
        // Phase 2: カテゴリ平均を使用（中コスト）
        if (goal_id && profile.category_stats[goal_id]) {
          const stats = profile.category_stats[goal_id];
          console.log('[Prediction] Using category average (learning phase):', {
            goal_id,
            avg_duration: stats.avg_work_duration,
            execution_count: stats.execution_count
          });
          
          return NextResponse.json({
            predicted_duration: Math.round(stats.avg_work_duration),
            confidence: stats.execution_count >= 5 ? 'medium' : 'low',
            prediction_method: 'category_avg',
            learning_phase: 'learning',
            message: `過去${stats.execution_count}回の実績から予測しました`
          });
        } else {
          // カテゴリデータがない場合はGeminiにフォールバック
          console.log('[Prediction] No category data, falling back to Gemini');
          const geminiDuration = await predictWithGemini(task_title, task_description);
          
          return NextResponse.json({
            predicted_duration: geminiDuration,
            confidence: 'low',
            prediction_method: 'gemini',
            learning_phase: 'learning',
            message: 'まだデータが不足しているため、AIで予測しました'
          });
        }
      
      case 'mature':
        // Phase 3: 重回帰モデルを使用（低コスト・高精度）
        if (profile.regression_model && profile.regression_model.r_squared > 0.3) {
          // 重回帰モデルで予測
          const now = new Date();
          const hour = now.getHours();
          let timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
          if (hour >= 5 && hour < 12) timeOfDay = 'morning';
          else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
          else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
          else timeOfDay = 'night';
          
          // カテゴリ平均を初期予測として使用
          let initialPrediction: number | null = null;
          if (goal_id && profile.category_stats[goal_id]) {
            initialPrediction = profile.category_stats[goal_id].avg_work_duration;
          }
          
          // regression_modelにsample_sizeが含まれていない場合はデフォルト値を設定
          const model: RegressionModel = profile.regression_model && 'sample_size' in profile.regression_model
            ? profile.regression_model as RegressionModel
            : { ...profile.regression_model, sample_size: 0 } as RegressionModel;
          
          const prediction = predictWithModel(model, {
            predicted_duration: initialPrediction,
            time_of_day: timeOfDay,
            day_of_week: now.getDay()
          });
          
          console.log('[Prediction] Using regression model (mature phase):', {
            r_squared: profile.regression_model.r_squared,
            prediction,
            time_of_day: timeOfDay,
            day_of_week: now.getDay()
          });
          
          return NextResponse.json({
            predicted_duration: prediction,
            confidence: profile.regression_model.r_squared > 0.7 ? 'high' : 'medium',
            prediction_method: 'regression',
            learning_phase: 'mature',
            r_squared: profile.regression_model.r_squared,
            message: `重回帰モデルで高精度予測（R²=${(profile.regression_model.r_squared * 100).toFixed(1)}%）`
          });
        } else if (goal_id && profile.category_stats[goal_id]) {
          // モデルが未学習またはR²が低い場合はカテゴリ平均
          const stats = profile.category_stats[goal_id];
          console.log('[Prediction] Using category average (mature phase - model not ready):', {
            goal_id,
            avg_duration: stats.avg_work_duration,
            execution_count: stats.execution_count
          });
          
          return NextResponse.json({
            predicted_duration: Math.round(stats.avg_work_duration),
            confidence: 'high',
            prediction_method: 'category_avg',
            learning_phase: 'mature',
            message: `過去${stats.execution_count}回の実績から高精度予測しました`
          });
        } else {
          // カテゴリデータがない場合はGeminiにフォールバック
          const geminiDuration = await predictWithGemini(task_title, task_description);
          
          return NextResponse.json({
            predicted_duration: geminiDuration,
            confidence: 'medium',
            prediction_method: 'gemini',
            learning_phase: 'mature',
            message: '新しいカテゴリのため、AIで予測しました'
          });
        }
      
      default:
        return NextResponse.json(
          { error: 'Invalid learning phase' },
          { status: 500 }
        );
    }
  } catch (error: any) {
    console.error('[Prediction] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Prediction failed' },
      { status: 500 }
    );
  }
}

