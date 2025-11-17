import { NextRequest, NextResponse } from 'next/server';
import { getFirebase } from '@/lib/firebase';
import { collection, getDocs, query, where, doc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { trainRegressionModel, type TrainingData } from '@/lib/regression';

// 認証チェック（本番環境では必須）
function checkAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  const secretKey = process.env.BATCH_SECRET_KEY || 'development-only-key';
  
  if (process.env.NODE_ENV === 'production' && authHeader !== `Bearer ${secretKey}`) {
    return false;
  }
  
  return true;
}

export async function POST(request: NextRequest) {
  try {
    // 認証チェック
    if (!checkAuth(request)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    const { db, auth } = getFirebase();
    
    // 管理者ユーザーでログイン（バッチ処理用）
    // 本番環境では、Firebase Admin SDKを使用
    const body = await request.json();
    const { user_id } = body;
    
    if (!user_id) {
      return NextResponse.json(
        { error: 'user_id is required' },
        { status: 400 }
      );
    }
    
    console.log('[Batch] モデル学習を開始:', user_id);
    
    // 学習プロファイルを取得
    const profileRef = doc(db, 'users', user_id, 'settings', 'learning_profile');
    const profileSnap = await getDoc(profileRef);
    
    if (!profileSnap.exists()) {
      return NextResponse.json(
        { error: 'Learning profile not found' },
        { status: 404 }
      );
    }
    
    const profile = profileSnap.data();
    
    // Mature フェーズでない場合はスキップ
    if (profile.learning_phase !== 'mature') {
      return NextResponse.json({
        message: 'Skipped: not in mature phase',
        phase: profile.learning_phase,
        total_executions: profile.total_executions
      });
    }
    
    // 未使用の学習データを取得
    const historyCol = collection(db, 'users', user_id, 'task_execution_history');
    const q = query(historyCol, where('used_for_training', '==', false));
    const snapshot = await getDocs(q);
    
    if (snapshot.empty || snapshot.size < 10) {
      return NextResponse.json({
        message: 'Skipped: insufficient new training data',
        new_data_count: snapshot.size
      });
    }
    
    // 学習データを準備
    const trainingData: TrainingData[] = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        actual_work_duration: data.actual_work_duration,
        predicted_duration: data.predicted_duration,
        time_of_day: data.time_of_day,
        day_of_week: data.day_of_week,
        goal_id: data.goal_id
      };
    });
    
    // モデルを学習
    const model = trainRegressionModel(trainingData);
    
    if (!model) {
      return NextResponse.json({
        message: 'Failed to train model',
        training_data_count: trainingData.length
      }, { status: 500 });
    }
    
    // モデルをプロファイルに保存
    await updateDoc(profileRef, {
      regression_model: {
        coefficients: model.coefficients,
        r_squared: model.r_squared,
        last_trained: serverTimestamp()
      },
      updated_at: serverTimestamp()
    });
    
    // 学習データを「使用済み」にマーク
    const updatePromises = snapshot.docs.map(doc => 
      updateDoc(doc.ref, { used_for_training: true })
    );
    await Promise.all(updatePromises);
    
    console.log('[Batch] モデル学習完了:', {
      user_id,
      r_squared: model.r_squared,
      sample_size: model.sample_size
    });
    
    return NextResponse.json({
      message: 'Model trained successfully',
      r_squared: model.r_squared,
      sample_size: model.sample_size,
      coefficients: model.coefficients
    });
    
  } catch (error: any) {
    console.error('[Batch] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Training failed' },
      { status: 500 }
    );
  }
}

